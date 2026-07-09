// Authorized by HUB-1550 — central FK-aware cleanup helpers for
// integration tests. Fixes the anti-pattern where per-test cleanup
// deleted parent rows (products, tenants) before child rows
// (product_registrations), which PostgreSQL rejects with:
//
// Authorized by HUB-1771 Phase 2 — added closeAppResources(app) helper.
// Each integration test file's afterAll should call this instead of
// bespoke pool/redis/app close sequences. Ensures every module-level
// singleton is torn down before the next test file's beforeAll runs,
// eliminating cross-file pollution from leaked connections/subscribers.
//
//   error: update or delete on table "products" violates foreign key
//     constraint "product_registrations_product_id_fkey" on table
//     "product_registrations"
//
// Root cause per HUB-1551 diagnosis: the ~110-test 429 rate-limit
// cascade masked this defect for months — tests never reached the
// setup that inserts product_registrations, so the FK never fired.
// Once the rate-limit fix landed and login started working end-to-end
// in tests, this FK ordering bug became visible.
//
// Fix (a) per HUB-1550: delete children first. NOT fix (b) (adding
// ON DELETE CASCADE to the FK) — that's a meaningful product-deletion
// semantic decision that would silently nuke registration history in
// production and should not be adopted just to fix a test cleanup bug.
//
// Consumer pattern:
//   import { cleanupProduct, cleanupTenant } from './_testCleanup.js';
//   afterEach(async () => {
//     await cleanupProduct(pool, productId);
//     await cleanupTenant(pool, tenantId);
//   });
//
// The helpers are idempotent — safe to call even if the row was
// already deleted by a prior cleanup step or the test itself.

import type { Pool } from 'pg';

/**
 * Delete a product row + every direct FK-child row that references it.
 * Ordered so PostgreSQL's FK checks don't reject the parent delete.
 *
 * Currently handles:
 *   - product_registrations (FK product_id → products.id)
 *
 * If future migrations add other tables with FKs to products.id, add
 * their cleanup here BEFORE the DELETE FROM products line so this
 * helper stays the single source of truth for product cleanup order.
 */
export async function cleanupProduct(
  pool: Pool,
  productId: string,
): Promise<void> {
  await pool.query(
    `DELETE FROM product_registrations WHERE product_id = $1`,
    [productId],
  );
  await pool.query(`DELETE FROM products WHERE id = $1`, [productId]);
}

/**
 * Delete a tenant row after its children have been cleaned up.
 * Callers MUST cleanup products (via cleanupProduct) first.
 *
 * This helper does not cascade to products deliberately — tests should
 * be explicit about which products they created so this doesn't
 * accidentally delete rows other tests are still using.
 */
export async function cleanupTenant(
  pool: Pool,
  tenantId: string,
): Promise<void> {
  await pool.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
}

// A minimal Fastify-like shape — importing the real type creates a circular
// devDep for tests that don't otherwise import Fastify.
interface HasClose {
  close(): Promise<void> | void;
}

/**
 * HUB-1771 Phase 2: idempotent test-file teardown that closes EVERY
 * module-level singleton the app touches. Call from afterAll(). Safe to
 * pass `undefined` if the test didn't build an app (some pure-service
 * tests only use the pg pool).
 *
 * The order is deliberate:
 *   1) Fastify (may still hold connections for in-flight requests)
 *   2) Settings pub/sub subscriber (a dedicated Redis client not tracked
 *      by closeRedis())
 *   3) pg Pool
 *   4) Main + BullMQ Redis clients (they share `redis/client.ts`)
 *   5) Stripe SDK singleton reset (so a next file can re-mock)
 *
 * Every step is guarded with try/catch — a partial failure MUST NOT
 * prevent the subsequent steps from running, or the next test file's
 * beforeAll may inherit a half-closed pool + a live subscriber. Any
 * errors are logged to stderr so a bug in one helper doesn't hide.
 */
export async function closeAppResources(app?: HasClose): Promise<void> {
  const step = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      process.stderr.write(`closeAppResources: ${name} failed: ${(err as Error).message}\n`);
    }
  };

  if (app) await step('app.close', () => app.close());
  await step('stopSettingsSubscriber', async () => {
    const mod = await import('../settings/index.js');
    await mod.stopSettingsSubscriber();
  });
  await step('closePool', async () => {
    const { closePool } = await import('../db/pool.js');
    await closePool();
  });
  await step('closeRedis', async () => {
    const { closeRedis } = await import('../redis/client.js');
    await closeRedis();
  });
  await step('_resetStripeClient', async () => {
    const { _resetStripeClient } = await import('../stripe/client.js');
    _resetStripeClient();
  });
}
