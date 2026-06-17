// Authorized by HUB-880 — HubClient class; HubClientConfig interface; constructor; connect()
// Authorized by HUB-894 — transparent token refresh; threshold check; single shared refresh promise
// Authorized by HUB-895 — 401 auto-retry; single re-auth attempt; HubAuthError on second 401
// Authorized by HUB-921 — LEASE_ENCRYPTION_KEY validation in connect()
// Authorized by HUB-956 — getLease() public method; full cache→HTTP→HMAC→decrypt→kill-switch→cache.set pipeline

import { acquireToken } from './auth/acquireToken.js';
import { HubAuthError, HubLeaseInvalidError, HubKillSwitchError } from './errors.js';
import { verifyLeaseSignature } from './lease/verifyLeaseSignature.js';
import { decryptLeaseToken } from './lease/decryptLeaseToken.js';
import { LeaseCache } from './lease/leaseCache.js';
import type { DecryptedLease } from './lease/types.js';

export interface HubClientConfig {
  clientId: string;
  clientSecret: string;
  hubUrl: string;
  timeoutMs?: number;
  tokenRefreshThresholdMs?: number;
}

export class HubClient {
  private readonly config: Required<HubClientConfig>;
  private token: string | null = null;
  private tokenExpiry: number | null = null;
  private refreshPromise: Promise<void> | null = null;
  private leaseEncryptionKey: Buffer | null = null;
  private readonly leaseCache: LeaseCache = new LeaseCache();

  constructor(config: HubClientConfig) {
    if (!config.clientId) throw new TypeError('clientId is required');
    if (!config.clientSecret) throw new TypeError('clientSecret is required');
    if (!config.hubUrl) throw new TypeError('hubUrl is required');
    this.config = {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      hubUrl: config.hubUrl,
      timeoutMs: config.timeoutMs ?? 10000,
      tokenRefreshThresholdMs: config.tokenRefreshThresholdMs ?? 60000,
    };
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
