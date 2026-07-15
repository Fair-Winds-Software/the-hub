// Authorized by HUB-1820 (S3 of HUB-1787) — MetricsClient. Buffers metric events and
// flushes to POST /api/v1/bi/metrics (the SDK-facing counterpart to the S3-of-HUB-1785
// backend admin ingestion endpoint). Same buffer + timed-flush pattern as HubClient's
// trackUsage() so operational behavior is familiar.
//
// Type safety: push(name, ...) is typed via MetricName so a typo fails at compile time
// inside the consuming app. Runtime check is defensive-only.
import type { MetricName } from './catalog.js';
import { isKnownMetricName } from './catalog.js';

export interface MetricEvent {
  metric_name: MetricName;
  value: number | string;
  dimensions?: Record<string, string>;
  occurred_at: string;
}

export interface IngestResult {
  accepted: number;
  dropped: Array<{ index: number; reason: string; category: string; metric_name?: string }>;
}

export interface MetricsClientConfig {
  /** How to acquire a Bearer token — reuse HubClient's ensureFreshToken pipeline. */
  getBearerToken: () => Promise<string>;
  hubUrl: string;
  timeoutMs?: number;
  maxBufferSize?: number;
  flushIntervalMs?: number;
}

export class MetricsClient {
  private readonly getBearerToken: () => Promise<string>;
  private readonly hubUrl: string;
  private readonly timeoutMs: number;
  private readonly maxBufferSize: number;
  private readonly flushIntervalMs: number;
  private buffer: MetricEvent[] = [];
  private flushing = false;
  private flushTimer: ReturnType<typeof setInterval> | undefined = undefined;

  constructor(config: MetricsClientConfig) {
    if (!config.getBearerToken) throw new TypeError('getBearerToken is required');
    if (!config.hubUrl) throw new TypeError('hubUrl is required');
    this.getBearerToken = config.getBearerToken;
    this.hubUrl = config.hubUrl;
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.maxBufferSize = config.maxBufferSize ?? 100;
    this.flushIntervalMs = config.flushIntervalMs ?? 30_000;
  }

  /**
   * Buffer a metric for the next flush. `occurred_at` defaults to now if omitted.
   * Throws synchronously if `name` is not in the catalog — a compile-time-checked
   * name is preferred (fails at type-check), but the runtime guard catches dynamic
   * misuse (e.g. from a config file).
   */
  push(
    name: MetricName,
    value: number | string,
    opts: { dimensions?: Record<string, string>; occurred_at?: string } = {},
  ): void {
    if (!isKnownMetricName(name)) {
      throw new TypeError(`unknown metric_name '${name}' — see METRIC_NAMES catalog`);
    }
    const event: MetricEvent = {
      metric_name: name,
      value,
      dimensions: opts.dimensions,
      occurred_at: opts.occurred_at ?? new Date().toISOString(),
    };
    this.buffer.push(event);
    if (this.buffer.length >= this.maxBufferSize) {
      void this.flush();
    }
  }

  /** Manual flush (useful for tests + graceful shutdown). Returns the ingest result. */
  async flush(): Promise<IngestResult> {
    if (this.buffer.length === 0 || this.flushing) return { accepted: 0, dropped: [] };
    this.flushing = true;
    const batch = this.buffer.splice(0);
    try {
      const token = await this.getBearerToken();
      const res = await fetch(`${this.hubUrl}/api/v1/bi/metrics`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ events: batch }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        // Re-buffer on failure — mirrors HubClient trackUsage() error-recovery.
        this.buffer.unshift(...batch);
        throw new Error(`metrics ingest failed: HTTP ${res.status}`);
      }
      return (await res.json()) as IngestResult;
    } catch (err) {
      if (this.buffer.length === 0) this.buffer.unshift(...batch);
      throw err;
    } finally {
      this.flushing = false;
    }
  }

  startFlushLoop(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      void this.flush().catch(() => {
        /* swallow — flush() already re-buffered; next tick retries */
      });
    }, this.flushIntervalMs);
    (this.flushTimer as NodeJS.Timeout).unref?.();
  }

  stopFlushLoop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  /** Test-only accessor for internal buffer state. */
  _bufferLengthForTest(): number {
    return this.buffer.length;
  }
}
