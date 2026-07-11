// Authorized by HUB-1790 (S1 of HUB-1783 — Generalize the connections framework) — base
// interface + type helpers for HUB's external-connection layer. Every external service HUB
// integrates with (Stripe today; Google Analytics, Plaid, etc. tomorrow) implements this
// contract. Concrete connections extend the base with their own domain facets via type
// intersection — the Stripe adapter adds `.customers`, `.subscriptions`, `.invoices`, etc.
// while still satisfying `ExternalConnection`.
//
// This file is type-only. No runtime code, no runtime imports. HUB-1791 (S2) consumes these
// types to build the multi-connection registry; HUB-1792 (S3) consumes ProbeResult for the
// shared status probe helper; HUB-1794 (S5) migrates the Stripe adapter to implement this
// interface.

/** Which side of the Live/Mock split a connection is currently serving. */
export type ConnectionMode = 'live' | 'mock';

/**
 * Three-state health outcome:
 * - `ok`         — probe succeeded within the timeout.
 * - `degraded`   — probe was rate-limited or partially working (still serving traffic).
 * - `down`       — probe failed, timed out, or the connection is unreachable.
 */
export type ConnectionHealth = 'ok' | 'degraded' | 'down';

/**
 * Return shape of `ExternalConnection.probe()`. `reason` is populated for `degraded` /
 * `down` outcomes so the operator UI can surface it in the tooltip / banner.
 */
export interface ProbeResult {
  health: ConnectionHealth;
  reason?: string;
  latency_ms: number;
}

/**
 * The full status object returned by the admin `/api/v1/admin/connections/:name/status`
 * endpoint (HUB-1793 / S4). Includes the connection name + mode + wall-clock timestamp
 * on top of the probe result, so the frontend can render everything from one payload.
 */
export interface ConnectionStatus {
  name: string;
  mode: ConnectionMode;
  health: ConnectionHealth;
  reason?: string;
  /** ISO 8601 timestamp of when the probe was last executed. */
  checked_at: string;
  latency_ms: number;
}

/**
 * The common surface every registered connection must implement. Domain-specific facets
 * (e.g. Stripe's `.customers`, GA's `.getPropertyReport`) are added on top via type
 * intersection — e.g. `type StripeConnection = ExternalConnection & { customers: ...; ... }`.
 *
 * The interface is intentionally small:
 *   - `name` identifies the connection in the registry + admin URLs (`/connections/:name`).
 *   - `mode()` reads the current mode from the registry so callers don't have to.
 *   - `probe()` runs a lightweight liveness check and reports back health + latency.
 *
 * Everything else (mode flipping, seeding, audit logging) lives at the registry layer,
 * not on the connection instance — a connection doesn't need to know how mode is stored.
 */
export interface ExternalConnection {
  readonly name: string;
  mode(): ConnectionMode;
  probe(): Promise<ProbeResult>;
}
