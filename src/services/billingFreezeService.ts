// Authorized by HUB-503 — billing freeze lifecycle: handleLicenseSuspended, handleLicenceCancelled, handleLicenseReactivated
// Authorized by HUB-504 — handleBillingPaymentFailed: billing-payment-failed queue processor entry point
// Authorized by HUB-517 — scanAndResolveExpiredGracePeriods: CRON-driven expiry resolution
import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';
import logger from '../lib/logger.js';
import { TODO_D_DEF_001_INTERVAL } from '../config/decisions.js';
import { suspendLicense } from './license.js';
import { cancelSubscription, createSubscription } from './stripeService.js';

// Opens a billing grace period for the tenant+product and schedules Stripe subscription
// cancellation at period end. Idempotent: no-op if an open grace period already exists.
export async function handleLicenseSuspended(
  tenantId: string,
  productId: string,
  reason: string,
): Promise<void> {
  if (TODO_D_DEF_001_INTERVAL === null) {
    throw new AppError(500, 'Grace window interval not yet configured (TODO-D-DEF-001)');
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: existing } = await client.query<{ id: string }>(
      `SELECT id FROM billing_grace_periods
       WHERE tenant_id = $1 AND product_id = $2 AND resolved_at IS NULL
       FOR UPDATE`,
      [tenantId, productId],
    );

    if (existing.length > 0) {
      await client.query('COMMIT');
      logger.info({ tenantId, productId }, 'handleLicenseSuspended: grace period already open — skipping');
      return;
    }

    await client.query(
      `INSERT INTO billing_grace_periods (tenant_id, product_id, expires_at, reason)
       VALUES ($1, $2, NOW() + $3::interval, $4)`,
      [tenantId, productId, TODO_D_DEF_001_INTERVAL, reason],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await cancelSubscription(tenantId, productId, false);
  logger.info({ tenantId, productId, reason }, 'grace period opened; Stripe subscription scheduled for cancellation at period end');
}

// Resolves the open grace period as 'cancelled' and cancels the Stripe subscription immediately.
// No-op if no open grace period exists.
export async function handleLicenceCancelled(
  tenantId: string,
  productId: string,
): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE billing_grace_periods
     SET resolved_at = NOW(), resolution = 'cancelled'
     WHERE tenant_id = $1 AND product_id = $2 AND resolved_at IS NULL
     RETURNING id`,
    [tenantId, productId],
  );

  if (rows.length === 0) {
    logger.warn({ tenantId, productId }, 'handleLicenceCancelled: no open grace period found');
    return;
  }

  await cancelSubscription(tenantId, productId, true);
  logger.info({ tenantId, productId }, 'grace period resolved as cancelled; Stripe subscription cancelled immediately');
}

// Resolves the open grace period as 'reactivated' and creates a new Stripe subscription.
// No-op if no open grace period exists.
export async function handleLicenseReactivated(
  tenantId: string,
  productId: string,
  stripePriceId: string,
  email: string,
): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE billing_grace_periods
     SET resolved_at = NOW(), resolution = 'reactivated'
     WHERE tenant_id = $1 AND product_id = $2 AND resolved_at IS NULL
     RETURNING id`,
    [tenantId, productId],
  );

  if (rows.length === 0) {
    logger.warn({ tenantId, productId }, 'handleLicenseReactivated: no open grace period found');
    return;
  }

  await createSubscription(tenantId, productId, stripePriceId, email);
  logger.info({ tenantId, productId }, 'grace period resolved as reactivated; new Stripe subscription created');
}

// Scans for expired open grace periods and resolves each as 'expired' with immediate
// Stripe subscription cancellation. Called by the grace-period-expiry-scanner CRON queue.
export async function scanAndResolveExpiredGracePeriods(): Promise<void> {
  const pool = getPool();

  const { rows } = await pool.query<{ id: string; tenant_id: string; product_id: string }>(
    `UPDATE billing_grace_periods
     SET resolved_at = NOW(), resolution = 'expired'
     WHERE resolved_at IS NULL AND expires_at < NOW()
     RETURNING id, tenant_id, product_id`,
  );

  if (rows.length === 0) {
    logger.info('scanAndResolveExpiredGracePeriods: no expired grace periods found');
    return;
  }

  logger.info({ count: rows.length }, 'scanAndResolveExpiredGracePeriods: resolving expired grace periods');

  for (const row of rows) {
    try {
      await cancelSubscription(row.tenant_id, row.product_id, true);
      logger.info({ gracePeriodId: row.id, tenantId: row.tenant_id, productId: row.product_id }, 'expired grace period: subscription cancelled immediately');
    } catch (err) {
      logger.error({ gracePeriodId: row.id, err }, 'scanAndResolveExpiredGracePeriods: failed to cancel subscription — grace period already resolved in DB');
    }
  }
}

// Entry point for billing_payment_failed queue jobs.
// Looks up tenant+product from the invoice, suspends the license (idempotent),
// and opens a billing grace period.
export async function handleBillingPaymentFailed(stripeInvoiceId: string): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<{ tenant_id: string; product_id: string }>(
    'SELECT tenant_id, product_id FROM invoices WHERE stripe_invoice_id = $1',
    [stripeInvoiceId],
  );

  if (!rows[0]) {
    logger.warn({ stripeInvoiceId }, 'handleBillingPaymentFailed: invoice not found in DB');
    return;
  }

  const { tenant_id: tenantId, product_id: productId } = rows[0];

  try {
    await suspendLicense(tenantId, productId, 'payment_failed');
  } catch (err) {
    // AppError(422) = license already suspended — idempotent; re-throw anything else
    if (!(err instanceof AppError) || err.statusCode !== 422) throw err;
  }

  await handleLicenseSuspended(tenantId, productId, 'payment_failed');
  logger.warn({ tenantId, productId, stripeInvoiceId }, 'payment_failed_license_suspended');
}
