// Authorized by HUB-1780 (S7 of HUB-1773) — unbypassable mock-only seed guard.
//
// The guard is the *only* line of defense preventing the seeding layer from touching real
// customer data. It reads mode from the S8 registry and throws when mode ≠ mock. Rules the
// guard enforces:
//
//   1. No config flag turns the guard off.
//   2. No env var turns it off (not even NODE_ENV=test).
//   3. No exported bypass function exists — the guard has one entry point, assertMockMode(),
//      and no companion "bypass for tests" export. Tests that need to exercise seeding must
//      first flip mode to 'mock' via the registry (which itself validates state).
//   4. Module-load check: the seeding module cannot be imported in a production process with
//      LIVE Stripe credentials present. Attempting to do so throws at module load, aborting
//      the process before any seed code executes.
//
// Mid-import mode-flip detection: seed layer callers invoke assertMockMode() per-row inside
// bulk loops (see src/stripe/seed/index.ts). If an operator flips mode mid-batch, the very
// next row's guard check catches it and rolls back the enclosing transaction.
//
// DEFERRED to v0.2 (AC6): a dedicated `hub_stripe_mock_writer` PG role that owns the
// stripe_mock schema, so INSERT/UPDATE/DELETE requires SET LOCAL ROLE. The role model is
// straightforward but interacts with MockStripeAdapter writes (which would also need role
// acquisition) and TRUNCATE ownership semantics; carrying that redesign is disproportionate
// to v0.1 pre-production risk. When HUB gets its first real Stripe key, tackle it then.
import { AppError } from '../../errors/AppError.js';
import { getStripeMode } from '../registry.js';

// ── Module-load-time refusal ────────────────────────────────────────────────────
// If a production process with live Stripe credentials ever import()s this module, we
// refuse to load. Importing seed code in a live Stripe process is prima facie a bug —
// there is no legitimate reason to run seeding against a real Stripe account.
if (process.env.NODE_ENV === 'production' && process.env.STRIPE_SECRET_KEY) {
  throw new Error(
    'Refusing to load Stripe seed module: NODE_ENV=production with STRIPE_SECRET_KEY set. ' +
      'Seeding is a development-only tool and must not be imported in production.',
  );
}

/**
 * Assert the current Stripe connection mode is 'mock'. Throws AppError(400) otherwise.
 *
 * Called at every seed API entry point AND inside every bulk-insert row loop so a
 * mid-import mode flip is caught immediately and the enclosing transaction rolls back.
 *
 * The guard is intentionally not exported alongside any bypass helper. Tests that need
 * seeding must flip mode via `registry._setStripeModeForTest('mock')` (which is itself
 * a test-only export on the registry, NOT the guard).
 */
export function assertMockMode(): void {
  const mode = getStripeMode();
  if (mode !== 'mock') {
    throw new AppError(400, 'Seeding forbidden — Stripe connection is in LIVE mode');
  }
}
