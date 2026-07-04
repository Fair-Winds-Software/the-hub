// Authorized by HUB-1550 — central FK-aware cleanup helpers for
// integration tests. Fixes the anti-pattern where per-test cleanup
// deleted parent rows (products, tenants) before child rows
// (product_registrations), which PostgreSQL rejects with:
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
