// Authorized by HUB-1791 (S2 of HUB-1783 — Generalize the connections framework) — generic
// multi-connection registry. Successor to src/stripe/registry.ts (HUB-1781 / S8 of HUB-1773),
// generalized so any number of external connections (Stripe, Google Analytics, Plaid, etc.)
// can be registered by name and mode-managed uniformly.
//
// Persistence model:
//   settings.connection_mode.<name> = { "mode": "live" | "mock" }
// Migration 081 renames the legacy key `stripe_connection_mode` → `connection_mode.stripe`
// idempotently, so existing HUB-1773 behavior is preserved after the cutover.
//
// Bootstrap:
//   initConnectionsRegistry() reads a mode row per registered connection. Missing rows are
//   seeded with the environment default (mock in non-prod; live in prod IF the connection's
//   credentialCheck returns true — otherwise fatal fail-fast).
//
// Mode flip:
//   setConnectionMode(name, target, actor) validates target credentials first (per-connection
//   credentialCheck), writes the setting, invalidates the cache, updates in-process mode, and
//   emits an `audit_log` entry (`operation = <name>.mode_change`).
//
// Test hooks (`_setConnectionModeForTest`, `_resetConnectionsRegistryForTest`) mirror the
// S8 hooks and are used by the S8/S9 tests that will migrate to this registry in S5.
import { getPool } from '../db/pool.js';
import { getSetting, invalidateSetting } from '../settings/index.js';
import { AppError } from '../errors/AppError.js';
import logger from '../lib/logger.js';
import type { ConnectionMode, ExternalConnection } from './base.js';

// ── Registration + module state ──────────────────────────────────────────────────

/**
 * Descriptor supplied at connection registration time. Contains the factories for each
 * mode + a credentialCheck the registry uses BEFORE persisting a live-mode flip.
 */
export interface ConnectionDescriptor<T extends ExternalConnection = ExternalConnection> {
  /** Stable name — becomes part of the URL and the settings key. Lowercase, snake_case. */
  name: string;
  /** Factory: build a live-mode adapter. Called lazily on first getConnection() with mode=live. */
  buildLive: () => T;
  /** Factory: build a mock-mode adapter. Called lazily on first getConnection() with mode=mock. */
  buildMock: () => T;
  /**
   * Return true iff all environment credentials required for LIVE mode are present. Called
   * on setConnectionMode('live') before writing; if false, the flip is rejected with 400 and
   * the setting is NOT updated. Also called at bootstrap when the persisted mode is 'live' —
   * a mismatch is fatal in production.
   */
  hasLiveCredentials: () => boolean;
}

interface RegisteredConnection<T extends ExternalConnection = ExternalConnection> {
  descriptor: ConnectionDescriptor<T>;
  currentMode: ConnectionMode | null;
  liveInstance: T | null;
  mockInstance: T | null;
}

const _registry = new Map<string, RegisteredConnection>();

function settingKey(name: string): string {
  return `connection_mode.${name}`;
}

// ── Registration ────────────────────────────────────────────────────────────────

/**
 * Register a connection with the registry. Called once per connection at bootstrap BEFORE
 * initConnectionsRegistry(). Idempotent: re-registering the same name replaces the previous
 * descriptor (useful in tests).
 */
export function registerConnection<T extends ExternalConnection>(
  descriptor: ConnectionDescriptor<T>,
): void {
  _registry.set(descriptor.name, {
    descriptor,
    currentMode: null,
    liveInstance: null,
    mockInstance: null,
  });
}

// ── Bootstrapping ───────────────────────────────────────────────────────────────

function envDefaultMode(entry: RegisteredConnection): ConnectionMode {
  if (process.env.NODE_ENV === 'production') {
    if (!entry.descriptor.hasLiveCredentials()) {
      logger.fatal(
        { connection: entry.descriptor.name },
        'Credentials missing — cannot start in production',
      );
      process.exit(1);
    }
    return 'live';
  }
  return 'mock';
}

/**
 * Reads the persisted mode for every registered connection and populates each in-process
 * cache. If any setting is absent, seeds it with the environment default (mock in non-prod;
 * live-with-cred-check in prod). Call from server bootstrap AFTER registerConnection() calls.
 */
export async function initConnectionsRegistry(): Promise<void> {
  for (const entry of _registry.values()) {
    const key = settingKey(entry.descriptor.name);
    let loaded = false;
    try {
      const value = await getSetting(key);
      if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'mode' in value) {
        const mode = (value as { mode: string }).mode;
        if (mode === 'live' || mode === 'mock') {
          entry.currentMode = mode;
          logger.info({ connection: entry.descriptor.name, mode }, 'Connection mode loaded from settings');
          if (mode === 'live' && !entry.descriptor.hasLiveCredentials()) {
            logger.fatal(
              { connection: entry.descriptor.name },
              'Persisted mode is LIVE but credentials are missing',
            );
            process.exit(1);
          }
          loaded = true;
        }
      }
      if (!loaded) {
        logger.warn(
          { connection: entry.descriptor.name, key, value },
          'Connection mode setting is malformed — seeding default',
        );
      }
    } catch (err) {
      if (!(err instanceof AppError && err.statusCode === 404)) {
        throw err;
      }
      // Setting not present — fall through to seed.
    }
    if (!loaded) {
      const seed = envDefaultMode(entry);
      await getPool().query(
        `INSERT INTO settings (key, value)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO NOTHING`,
        [key, JSON.stringify({ mode: seed })],
      );
      entry.currentMode = seed;
      logger.info(
        { connection: entry.descriptor.name, mode: seed },
        'Connection mode seeded (default for environment)',
      );
    }
  }
}

// ── Accessors ───────────────────────────────────────────────────────────────────

function requireEntry(name: string): RegisteredConnection {
  const entry = _registry.get(name);
  if (!entry) {
    throw new AppError(404, `Unknown connection: ${name}`);
  }
  return entry;
}

/**
 * Returns the current mode for the named connection. Synchronous — reads from the in-process
 * cache. Non-production falls back to 'live' if the entry was never initialized, matching
 * HUB-1781's ergonomic behavior for legacy tests.
 */
export function getConnectionMode(name: string): ConnectionMode {
  const entry = requireEntry(name);
  if (entry.currentMode === null) {
    if (process.env.NODE_ENV === 'production') {
      throw new AppError(
        500,
        `Connection registry not initialized for '${name}' — call initConnectionsRegistry() during bootstrap`,
      );
    }
    entry.currentMode = 'live';
  }
  return entry.currentMode;
}

/**
 * Returns the active adapter for the named connection. Lazy-instantiates via the descriptor's
 * buildLive/buildMock factory and caches per process. Cast the return to your concrete
 * connection interface at the call site (e.g. `getConnection<StripeConnection>('stripe')`).
 */
export function getConnection<T extends ExternalConnection = ExternalConnection>(name: string): T {
  const entry = requireEntry(name);
  const mode = getConnectionMode(name);
  if (mode === 'live') {
    if (!entry.liveInstance) entry.liveInstance = entry.descriptor.buildLive();
    return entry.liveInstance as T;
  }
  if (!entry.mockInstance) entry.mockInstance = entry.descriptor.buildMock();
  return entry.mockInstance as T;
}

/**
 * Returns a snapshot of every registered connection with its current mode. Used by the
 * generic `/api/v1/admin/connections` list endpoint (HUB-1793 / S4).
 */
export function listConnections(): Array<{ name: string; mode: ConnectionMode }> {
  const out: Array<{ name: string; mode: ConnectionMode }> = [];
  for (const [name] of _registry) {
    out.push({ name, mode: getConnectionMode(name) });
  }
  return out;
}

// ── Mode flip ───────────────────────────────────────────────────────────────────

export interface ConnectionModeChangeActor {
  operator_id?: string | null;
  actor_type?: string | null;
}

/**
 * Flips the persisted mode for the named connection. Validates credentials first (never
 * persist a mode HUB can't honor); writes the setting; invalidates the cache; updates the
 * in-process mode; writes an audit_log entry.
 */
export async function setConnectionMode(
  name: string,
  target: ConnectionMode,
  actor: ConnectionModeChangeActor,
): Promise<void> {
  const entry = requireEntry(name);
  if (target === 'live' && !entry.descriptor.hasLiveCredentials()) {
    throw new AppError(400, `Cannot switch '${name}' to LIVE — credentials missing`);
  }
  const previous = entry.currentMode;
  const key = settingKey(name);
  const pool = getPool();
  await pool.query(
    `INSERT INTO settings (key, value)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify({ mode: target })],
  );
  await invalidateSetting(key);
  entry.currentMode = target;

  try {
    await pool.query(
      `INSERT INTO audit_log (tenant_id, actor_id, actor_type, operation, table_name, record_id, old_values, new_values)
       VALUES (NULL, $1, $2, $3, 'settings', $4, $5::jsonb, $6::jsonb)`,
      [
        actor.operator_id ?? null,
        actor.actor_type ?? 'operator',
        `${name}.mode_change`,
        key,
        JSON.stringify({ mode: previous }),
        JSON.stringify({ mode: target }),
      ],
    );
  } catch (err) {
    logger.warn({ err, connection: name }, 'Failed to write audit_log entry for connection mode change');
  }

  logger.info(
    { connection: name, previous, target, operator_id: actor.operator_id },
    'Connection mode flipped',
  );
}

// ── Test hooks ──────────────────────────────────────────────────────────────────

/** Test-only: force a connection's in-process mode without touching PG. */
export function _setConnectionModeForTest(name: string, mode: ConnectionMode | null): void {
  const entry = _registry.get(name);
  if (!entry) return;
  entry.currentMode = mode;
}

/**
 * Test-only: reset the entire registry (drops all registered connections + their cached
 * instances + modes). Follow with fresh registerConnection() calls in the same beforeEach.
 */
export function _resetConnectionsRegistryForTest(): void {
  _registry.clear();
}

/**
 * Test-only: reset a single connection's cached adapter instances + mode without dropping
 * its registration. Use when a test wants a fresh factory-built adapter but the same
 * descriptor (e.g., to swap in a re-configured SDK mock).
 */
export function _resetConnectionInstancesForTest(name: string): void {
  const entry = _registry.get(name);
  if (!entry) return;
  entry.liveInstance = null;
  entry.mockInstance = null;
  entry.currentMode = null;
}
