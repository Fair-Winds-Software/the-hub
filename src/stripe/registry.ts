// Authorized by HUB-1781 (S8 of HUB-1773) — Stripe connection registry + mode toggle.
// The registry resolves the active adapter (LiveStripeAdapter | MockStripeAdapter) based
// on the persisted mode in settings_catalog.stripe_connection_mode. HUB code depends only
// on getStripeConnection() — never on the SDK singleton directly.
//
// Mode source of truth: PG `settings` table, key = 'stripe_connection_mode',
// value = { "mode": "live" | "mock" }. Read via the existing Redis-fronted settings-cache.
//
// Authorized by HUB-1794 (S5 of HUB-1783) — this file is now a shim over the generic
// connections registry (src/connections/registry.ts). The historical getStripeMode /
// getStripeConnection / setStripeMode / initStripeRegistry exports remain as compatibility
// re-exports so the 7 service files that consume them keep working unchanged. New code
// should prefer getConnection<StripeConnection>('stripe') from the generic registry directly.
//
// Bootstrap flow (unchanged from S8's caller perspective):
//   1. src/index.ts calls initStripeRegistry() at boot
//   2. That in turn calls registerConnection({ name: 'stripe', ... }) + initConnectionsRegistry()
//   3. Downstream getStripeConnection() delegates to getConnection<StripeConnection>('stripe')
//
// Startup: initStripeRegistry() runs at boot and populates the mode cache. If the setting
// is absent, defaults to 'mock' in non-production and 'live' (with credential check) in
// production. Missing LIVE credentials at boot with mode=live is a fail-fast.
//
// Mode flips go through setStripeMode(), which:
//   - validates target credentials before writing (never persist a mode HUB can't honor)
//   - writes the settings row + invalidates the cache + updates the in-process mode
//   - emits an audit_log entry keyed by the acting operator
// There is no implicit MOCK↔LIVE fallback: a failed LIVE call throws, does not fall back.
import {
  registerConnection,
  initConnectionsRegistry,
  getConnection,
  getConnectionMode,
  setConnectionMode,
  _setConnectionModeForTest,
  _resetConnectionsRegistryForTest,
} from '../connections/registry.js';
import type { StripeConnection } from './connection.js';
import { LiveStripeAdapter } from './liveAdapter.js';
import { MockStripeAdapter } from './mockAdapter.js';

export type StripeMode = 'live' | 'mock';

// ── Credential check (Stripe-specific) ──────────────────────────────────────────

function hasLiveCredentials(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SIGNING_SECRET);
}

// ── Registration with the generic connections registry ─────────────────────────

let _registered = false;

function ensureRegistered(): void {
  if (_registered) return;
  registerConnection({
    name: 'stripe',
    buildLive: () => new LiveStripeAdapter(),
    buildMock: () => new MockStripeAdapter(),
    hasLiveCredentials,
  });
  _registered = true;
}

/**
 * Backward-compat wrapper around initConnectionsRegistry(). Bootstrap flow (unchanged for
 * src/index.ts callers): register + init in one go.
 */
export async function initStripeRegistry(): Promise<void> {
  ensureRegistered();
  await initConnectionsRegistry();
}

// ── Accessors (delegates) ───────────────────────────────────────────────────────

export function getStripeMode(): StripeMode {
  ensureRegistered();
  return getConnectionMode('stripe');
}

export function getStripeConnection(): StripeConnection {
  ensureRegistered();
  return getConnection<StripeConnection>('stripe');
}

// ── Mode flip (delegate) ────────────────────────────────────────────────────────

export interface StripeModeChangeActor {
  operator_id?: string | null;
  actor_type?: string | null;
}

export async function setStripeMode(
  target: StripeMode,
  actor: StripeModeChangeActor,
): Promise<void> {
  ensureRegistered();
  await setConnectionMode('stripe', target, actor);
}

// ── Test hooks (delegates) ──────────────────────────────────────────────────────

export function _setStripeModeForTest(mode: StripeMode | null): void {
  ensureRegistered();
  _setConnectionModeForTest('stripe', mode);
}

export function _resetStripeRegistryForTest(): void {
  _resetConnectionsRegistryForTest();
  _registered = false;
}
