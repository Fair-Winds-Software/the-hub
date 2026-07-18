// Authorized by HUB-880 — HubClient class; HubClientConfig interface; constructor; connect()
// Authorized by HUB-894 — transparent token refresh; threshold check; single shared refresh promise
// Authorized by HUB-895 — 401 auto-retry; single re-auth attempt; HubAuthError on second 401
// Authorized by HUB-921 — LEASE_ENCRYPTION_KEY validation in connect()
// Authorized by HUB-956 — getLease() public method; full cache→HTTP→HMAC→decrypt→kill-switch→cache.set pipeline
// Authorized by HUB-970 — trackUsage(); #buffer; #maxBufferSize; occurred_at stamping; size-threshold trigger
// Authorized by HUB-971 — #flush(); #startFlushLoop(); #flushTimer; interval + size triggers; ingested_late; POST /api/v1/usage/ingest
// Authorized by HUB-984 — #flushing guard; buffer rollback on failure; TODO-D-DEF-004 marker
// Authorized by HUB-985 — disconnect(); flush race; disconnectFlushTimeoutMs; clearInterval/clearTimeout; auth clear
// Authorized by HUB-986 — #reportVersion(); #versionHeartbeatTimer; POST /api/v1/sdk/version; SDK_VERSION
// Authorized by HUB-1005 — ping(); GET /api/v1/health; { ok, latencyMs }

import { acquireToken } from './auth/acquireToken.js';
import { HubAuthError, HubLeaseInvalidError, HubKillSwitchError } from './errors.js';
import { verifyLeaseSignature } from './lease/verifyLeaseSignature.js';
import { decryptLeaseToken } from './lease/decryptLeaseToken.js';
import { LeaseCache } from './lease/leaseCache.js';
import type { DecryptedLease } from './lease/types.js';
import type { UsageBufferEntry, UsageEvent } from './usage/types.js';
import { SDK_VERSION } from './version.js';

export interface HubClientConfig {
  clientId: string;
  clientSecret: string;
  hubUrl: string;
  timeoutMs?: number;
  tokenRefreshThresholdMs?: number;
  maxBufferSize?: number;
  flushIntervalMs?: number;
  lateThresholdMs?: number;
  disconnectFlushTimeoutMs?: number;
  versionReportIntervalMs?: number;
}

export class HubClient {
  private readonly config: Required<HubClientConfig>;
  private token: string | null = null;
  private tokenExpiry: number | null = null;
  private refreshPromise: Promise<void> | null = null;
  private leaseEncryptionKey: Buffer | null = null;
  private readonly leaseCache: LeaseCache = new LeaseCache();

  // Hard private fields — ES2022 (HUB-970, HUB-971, HUB-984, HUB-986)
  readonly #maxBufferSize: number;
  readonly #flushIntervalMs: number;
  readonly #lateThresholdMs: number;
  readonly #disconnectFlushTimeoutMs: number;
  readonly #versionReportIntervalMs: number;
  #connected = false;
  #buffer: UsageBufferEntry[] = [];
  #flushing = false;
  #flushTimer: ReturnType<typeof setInterval> | undefined = undefined;
  #versionHeartbeatTimer: ReturnType<typeof setInterval> | undefined = undefined;

  constructor(config: HubClientConfig) {
    if (!config.clientId) throw new TypeError('clientId is required');
    if (!config.clientSecret) throw new TypeError('clientSecret is required');
    if (!config.hubUrl) throw new TypeError('hubUrl is required');
    this.config = {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      hubUrl: config.hubUrl,
      timeoutMs: config.timeoutMs ?? 10_000,
      tokenRefreshThresholdMs: config.tokenRefreshThresholdMs ?? 60_000,
      maxBufferSize: config.maxBufferSize ?? 100,
      flushIntervalMs: config.flushIntervalMs ?? 30_000,
      lateThresholdMs: config.lateThresholdMs ?? 60_000,
      disconnectFlushTimeoutMs: config.disconnectFlushTimeoutMs ?? 5_000,
      versionReportIntervalMs: config.versionReportIntervalMs ?? 3_600_000,
    };
    this.#maxBufferSize = this.config.maxBufferSize;
    this.#flushIntervalMs = this.config.flushIntervalMs;
    this.#lateThresholdMs = this.config.lateThresholdMs;
    this.#disconnectFlushTimeoutMs = this.config.disconnectFlushTimeoutMs;
    this.#versionReportIntervalMs = this.config.versionReportIntervalMs;
  }

  async connect(): Promise<void> {
    const raw = process.env.LEASE_ENCRYPTION_KEY;
    if (raw !== undefined) {
      const key = Buffer.from(raw, 'base64');
      if (key.length < 32) {
        throw new TypeError('LEASE_ENCRYPTION_KEY must decode to at least 32 bytes');
      }
      this.leaseEncryptionKey = key;
    }
    await this.ensureFreshToken();
    if (!this.#connected) {
      this.#connected = true;
      await this.#reportVersion();
      this.#versionHeartbeatTimer = setInterval(
        () => { void this.#reportVersion(); },
        this.#versionReportIntervalMs,
      );
      (this.#versionHeartbeatTimer as NodeJS.Timeout).unref?.();
      this.#startFlushLoop();
    }
  }

  /**
   * Get the current access token, refreshing if it's expired or unset.
   *
   * Authorized by HUB-1867 (S2 of HUB-1865) — public accessor so consumers
   * (e.g. LaunchKit's @launchkit/components HubResolver overload — LK-5034)
   * don't reach into the private `token` field with an unsafe cast.
   *
   * Idempotent + refresh-aware: safe to call before or after connect().
   * Throws HubAuthError if the refresh flow completed but no token was set
   * (defensive — should never happen in practice).
   */
  async getToken(): Promise<string> {
    await this.ensureFreshToken();
    if (this.token === null) {
      throw new HubAuthError('getToken(): token unavailable after refresh', 401);
    }
    return this.token;
  }

  trackUsage(
    tenantId: string,
    productId: string,
    eventData: { event_type: string; quantity: number },
  ): void {
    const now = Date.now();
    const event: UsageEvent = {
      tenant_id: tenantId,
      product_id: productId,
      event_type: eventData.event_type,
      quantity: eventData.quantity,
      occurred_at: new Date(now).toISOString(),
    };
    this.#buffer.push({ event, capturedAt: now });
    if (this.#buffer.length >= this.#maxBufferSize) {
      this.#triggerFlush();
    }
  }

  async ping(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      const res = await this.requestWithRetry(token =>
        fetch(`${this.config.hubUrl}/api/v1/health`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      return { ok: res.ok, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }

  async disconnect(): Promise<void> {
    clearInterval(this.#flushTimer);
    this.#flushTimer = undefined;
    clearTimeout(this.#versionHeartbeatTimer);
    this.#versionHeartbeatTimer = undefined;
    this.#connected = false;

    if (this.#buffer.length > 0) {
      let timeoutFired = false;
      const timeoutPromise = new Promise<void>(resolve =>
        setTimeout(() => {
          timeoutFired = true;
          resolve();
        }, this.#disconnectFlushTimeoutMs),
      );
      await Promise.race([this.#flush(), timeoutPromise]);
      if (timeoutFired) {
        console.warn('disconnect() timeout; events may be lost', {
          remainingCount: this.#buffer.length,
        });
      }
    }

    this.token = null;
    this.tokenExpiry = null;
    this.refreshPromise = null;
  }

  async getLease(tenantId: string, productId: string): Promise<DecryptedLease> {
    if (!this.leaseEncryptionKey) {
      throw new HubLeaseInvalidError(
        'LEASE_ENCRYPTION_KEY environment variable is required for getLease(); set it before calling connect()',
      );
    }

    const cacheKey = `${tenantId}:${productId}`;

    const cached = this.leaseCache.getCached(cacheKey);
    if (cached) return cached;

    const inflight = this.leaseCache.getInflight(cacheKey);
    if (inflight) return inflight;

    const key = this.leaseEncryptionKey;
    const promise = (async (): Promise<DecryptedLease> => {
      const response = await this.requestWithRetry(token =>
        fetch(`${this.config.hubUrl}/api/v1/leases/${tenantId}/${productId}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(this.config.timeoutMs),
        }),
      );

      if (!response.ok) {
        throw new HubLeaseInvalidError(`Lease fetch failed with status ${response.status}`);
      }

      const { lease_token: rawToken } = (await response.json()) as { lease_token: string };
      const encryptedBase64 = verifyLeaseSignature(rawToken, this.config.clientSecret);
      const payload = decryptLeaseToken(encryptedBase64, key);

      if (payload.killSwitch) {
        throw new HubKillSwitchError(
          `Kill switch active for tenant ${tenantId} on product ${productId}`,
          tenantId,
          productId,
        );
      }

      const { killSwitch: _ks, ...lease } = payload;
      this.leaseCache.set(cacheKey, lease);
      return lease;
    })();

    this.leaseCache.trackInflight(cacheKey, promise);
    return promise;
  }

  #startFlushLoop(): void {
    this.#flushTimer = setInterval(() => { void this.#flush(); }, this.#flushIntervalMs);
    (this.#flushTimer as NodeJS.Timeout).unref?.();
  }

  #triggerFlush(): void {
    if (this.#flushing) return;
    void this.#flush();
  }

  async #flush(): Promise<void> {
    if (this.#buffer.length === 0 || this.#flushing) return;
    this.#flushing = true;
    const batch = this.#buffer.splice(0);
    try {
      const flushTime = Date.now();
      const events: UsageEvent[] = batch.map(entry => ({
        ...entry.event,
        ingested_late: flushTime - entry.capturedAt > this.#lateThresholdMs,
        // TODO-D-DEF-003: cost_ledger granularity — no value hardcoded
      }));
      const res = await this.requestWithRetry(token =>
        fetch(`${this.config.hubUrl}/api/v1/usage/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ events }),
        }),
      );
      if (!res.ok) throw new Error(`Flush HTTP ${res.status}`);
    } catch (err) {
      // TODO-D-DEF-004: buffer durability bound — max cap and eviction policy TBD; no value hardcoded
      this.#buffer.unshift(...batch);
      console.warn('Usage flush failed; events retained', {
        bufferedCount: this.#buffer.length,
        err,
      });
    } finally {
      this.#flushing = false;
    }
  }

  async #reportVersion(): Promise<void> {
    try {
      await this.requestWithRetry(token =>
        fetch(`${this.config.hubUrl}/api/v1/sdk/version`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ sdk_version: SDK_VERSION, client_id: this.config.clientId }),
        }),
      );
    } catch (err) {
      console.warn('Version report failed; SDK continues operating', { err });
    }
  }

  private async ensureFreshToken(): Promise<void> {
    if (
      this.token !== null &&
      this.tokenExpiry !== null &&
      Date.now() < this.tokenExpiry - this.config.tokenRefreshThresholdMs
    ) {
      return;
    }
    if (!this.refreshPromise) {
      this.refreshPromise = acquireToken(
        this.config.hubUrl,
        this.config.clientId,
        this.config.clientSecret,
        this.config.timeoutMs,
      )
        .then(({ token, expiresAt }) => {
          this.token = token;
          this.tokenExpiry = expiresAt;
        })
        .finally(() => {
          this.refreshPromise = null;
        });
    }
    await this.refreshPromise;
  }

  private async requestWithRetry(
    requestFn: (token: string) => Promise<Response>,
  ): Promise<Response> {
    await this.ensureFreshToken();
    let response = await requestFn(this.token!);
    if (response.status === 401) {
      this.token = null;
      this.tokenExpiry = null;
      this.refreshPromise = null;
      await this.ensureFreshToken();
      response = await requestFn(this.token!);
      if (response.status === 401) {
        throw new HubAuthError('Authentication failed after retry', 401);
      }
    }
    return response;
  }
}
