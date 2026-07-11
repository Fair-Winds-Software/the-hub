// Authorized by HUB-1781 (S8 of HUB-1773) — Stripe connection registry + mode toggle.
// The registry resolves the active adapter (LiveStripeAdapter | MockStripeAdapter) based
// on the persisted mode in settings_catalog.stripe_connection_mode. HUB code depends only
// on getStripeConnection() — never on the SDK singleton directly.
//
// Mode source of truth: PG `settings` table, key = 'stripe_connection_mode',
// value = { "mode": "live" | "mock" }. Read via the existing Redis-fronted settings-cache.
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
import { getPool } from '../db/pool.js';
import { getSetting, invalidateSetting } from '../settings/index.js';
import { AppError } from '../errors/AppError.js';
import logger from '../lib/logger.js';
import type { StripeConnection } from './connection.js';
import { LiveStripeAdapter } from './liveAdapter.js';
import { MockStripeAdapter } from './mockAdapter.js';

export type StripeMode = 'live' | 'mock';

const SETTING_KEY = 'stripe_connection_mode';

// ── Module state ────────────────────────────────────────────────────────────────

let _currentMode: StripeMode | null = null;
let _liveAdapter: LiveStripeAdapter | null = null;
let _mockAdapter: MockStripeAdapter | null = null;

// ── Bootstrapping ───────────────────────────────────────────────────────────────

function hasLiveCredentials(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SIGNING_SECRET);
}

function defaultMode(): StripeMode {
  if (process.env.NODE_ENV === 'production') {
    if (!hasLiveCredentials()) {
      logger.fatal('STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SIGNING_SECRET missing — cannot start in production');
      process.exit(1);
    }
    return 'live';
  }
  return 'mock';
}

/**
 * Reads persisted mode from settings and populates the in-process cache. Called from
 * server bootstrap (src/server.ts) before the first Stripe call. If the setting is absent,
 * seeds it with the environment-appropriate default.
 */
export async function initStripeRegistry(): Promise<void> {
  try {
    const value = await getSetting(SETTING_KEY);
    if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'mode' in value) {
      const mode = (value as { mode: string }).mode;
      if (mode === 'live' || mode === 'mock') {
        _currentMode = mode;
        logger.info({ mode }, 'Stripe connection mode loaded from settings');
        if (mode === 'live' && !hasLiveCredentials()) {
          logger.fatal('Persisted mode is LIVE but Stripe credentials are missing');
          process.exit(1);
        }
        return;
      }
    }
    logger.warn({ value }, 'settings.stripe_connection_mode is malformed — seeding default');
  } catch (err) {
    if (!(err instanceof AppError && err.statusCode === 404)) {
      throw err;
    }
    // Setting not present — seed it with the default for this environment.
  }
  const seed = defaultMode();
  await getPool().query(
    `INSERT INTO settings (key, value)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO NOTHING`,
    [SETTING_KEY, JSON.stringify({ mode: seed })],
  );
  _currentMode = seed;
  logger.info({ mode: seed }, 'Stripe connection mode seeded (default for environment)');
}

// ── Accessors ───────────────────────────────────────────────────────────────────

/**
 * Returns the current Stripe connection mode. Synchronous — reads from the in-process cache
 * populated by initStripeRegistry().
 *
 * When called before init in NON-production, silently defaults to 'live' — this keeps
 * legacy unit tests that mock `getStripe()` (pre-adapter refactor) working without every
 * test also having to seed the registry. The Live adapter wraps their mocked SDK the same
 * way it would in production. In production, uninitialized access is a hard error.
 */
export function getStripeMode(): StripeMode {
  if (_currentMode === null) {
    if (process.env.NODE_ENV === 'production') {
      throw new AppError(
        500,
        'Stripe registry not initialized — call initStripeRegistry() during server bootstrap',
      );
    }
    _currentMode = 'live';
  }
  return _currentMode;
}

/**
 * Returns the active StripeConnection adapter based on the current mode. Adapters are
 * lazy-instantiated and cached per process.
 *
 * NO implicit fallback: if mode=live and a call fails, the caller sees the error. Mode is
 * an explicit operational choice, not an availability fallback.
 */
export function getStripeConnection(): StripeConnection {
  const mode = getStripeMode();
  if (mode === 'live') {
    if (!_liveAdapter) _liveAdapter = new LiveStripeAdapter();
    return _liveAdapter;
  }
  if (!_mockAdapter) _mockAdapter = new MockStripeAdapter();
  return _mockAdapter;
}

// ── Mode flip ───────────────────────────────────────────────────────────────────

export interface StripeModeChangeActor {
  operator_id?: string | null;
  actor_type?: string | null;
}

/**
 * Flips the persisted Stripe connection mode. Validates target credentials BEFORE writing.
 * Writes the settings row, invalidates the cache, updates the in-process mode, and appends
 * an audit_log entry.
 */
export async function setStripeMode(
  target: StripeMode,
  actor: StripeModeChangeActor,
): Promise<void> {
  if (target === 'live' && !hasLiveCredentials()) {
    throw new AppError(400, 'Cannot switch to LIVE — Stripe credentials missing');
  }
  const previous = _currentMode;
  const pool = getPool();
  await pool.query(
    `INSERT INTO settings (key, value)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [SETTING_KEY, JSON.stringify({ mode: target })],
  );
  await invalidateSetting(SETTING_KEY);
  _currentMode = target;

  // Audit — best-effort; a failed audit write must not roll back the mode change.
  try {
    await pool.query(
      `INSERT INTO audit_log (tenant_id, actor_id, actor_type, operation, table_name, record_id, old_values, new_values)
       VALUES (NULL, $1, $2, 'stripe.mode_change', 'settings', $3, $4::jsonb, $5::jsonb)`,
      [
        actor.operator_id ?? null,
        actor.actor_type ?? 'operator',
        SETTING_KEY,
        JSON.stringify({ mode: previous }),
        JSON.stringify({ mode: target }),
      ],
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to write audit_log entry for stripe.mode_change');
  }

  logger.info({ previous, target, operator_id: actor.operator_id }, 'Stripe connection mode flipped');
}

// ── Test hooks ──────────────────────────────────────────────────────────────────

/**
 * Test-only: force the in-process mode without touching PG. Does not persist. Used by
 * unit tests that want to exercise the registry's routing without a full DB roundtrip.
 */
export function _setStripeModeForTest(mode: StripeMode | null): void {
  _currentMode = mode;
}

/**
 * Test-only: reset the cached adapters so a fresh SDK mock can be injected via
 * LiveStripeAdapter constructor arg in tests.
 */
export function _resetStripeRegistryForTest(): void {
  _currentMode = null;
  _liveAdapter = null;
  _mockAdapter = null;
}
