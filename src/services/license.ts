// Authorized by HUB-258 — createLicense, activateLicense; FSM pending→active
// Authorized by HUB-259 — suspendLicense, freezeLicense, cancelLicense; FSM transitions + D-001 alert
// Authorized by HUB-272 — getLicenseStatus; promoteStagedLicenseChanges CRON handler
// Authorized by HUB-279 — emitBelowFloorAlert; post-commit fire-and-forget side effect
// Authorized by HUB-1496 — unfreezeProduct; admin override suspended→active; no Stripe involvement
import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';
import logger from '../lib/logger.js';
import { TODO_D_DEF_001_INTERVAL } from '../config/decisions.js';

export type LicenseStatus = 'pending' | 'active' | 'suspended' | 'cancelled';

interface LicenseRow {
  id: string;
  status: LicenseStatus;
}

export interface GetLicenseStatusResult {
  status: LicenseStatus;
  grace_expires_at: Date | null;
  staged_change?: { new_status: string; staged_at: Date };
}

interface BelowFloorAlertPayload {
  tenantId: string;
  productId: string;
  reason: string;
  suspended_at: Date;
  grace_expires_at: Date;
}

// ── createLicense ─────────────────────────────────────────────────────────────

export async function createLicense(
  tenantId: string,
  productId: string,
): Promise<{ id: string }> {
  const pool = getPool();
  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO licenses (tenant_id, product_id, status)
       VALUES ($1, $2, 'pending')
       RETURNING id`,
      [tenantId, productId],
    );
    const id = rows[0]!.id;
    logger.info({ tenant_id: tenantId, product_id: productId, licenseId: id }, 'License created');
    return { id };
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new AppError(409, 'License already exists for this tenant-product pair');
    }
    throw err;
  }
}

// ── activateLicense ───────────────────────────────────────────────────────────

export async function activateLicense(
  tenantId: string,
  productId: string,
): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query<LicenseRow>(
      `SELECT id, status FROM licenses
       WHERE tenant_id = $1 AND product_id = $2
       FOR UPDATE`,
      [tenantId, productId],
    );
    if (rows.length === 0) throw new AppError(404, 'License not found');
    if (rows[0]!.status !== 'pending') throw new AppError(422, 'License is not in pending state');

    const { rows: reg } = await client.query<{ status: string }>(
      `SELECT status FROM product_registrations WHERE id = $1`,
      [productId],
    );
    if (reg.length === 0) throw new AppError(404, 'Product registration not found');
    if (reg[0]!.status !== 'active') throw new AppError(422, 'Product registration is not active');

    await client.query(
      `UPDATE licenses SET status = 'active', updated_at = NOW()
       WHERE tenant_id = $1 AND product_id = $2`,
      [tenantId, productId],
    );

    await client.query('COMMIT');
    logger.info({ tenant_id: tenantId, product_id: productId }, 'License activated: pending → active');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── suspendLicense ────────────────────────────────────────────────────────────

export async function suspendLicense(
  tenantId: string,
  productId: string,
  reason: string,
): Promise<void> {
  if (TODO_D_DEF_001_INTERVAL === null) {
    throw new AppError(500, 'Grace window interval not yet configured (TODO-D-DEF-001)');
  }

  const pool = getPool();
  const client = await pool.connect();
  let alertPayload: BelowFloorAlertPayload | null = null;

  try {
    await client.query('BEGIN');

    const { rows } = await client.query<LicenseRow>(
      `SELECT id, status FROM licenses
       WHERE tenant_id = $1 AND product_id = $2
       FOR UPDATE`,
      [tenantId, productId],
    );
    if (rows.length === 0) throw new AppError(404, 'License not found');
    if (rows[0]!.status !== 'active') throw new AppError(422, 'License is not in active state');

    const { rows: updated } = await client.query<{
      suspended_at: Date;
      grace_expires_at: Date;
    }>(
      `UPDATE licenses
       SET status = 'suspended',
           reason = $3,
           suspended_at = NOW(),
           grace_expires_at = NOW() + $4::interval,
           updated_at = NOW()
       WHERE tenant_id = $1 AND product_id = $2
       RETURNING suspended_at, grace_expires_at`,
      [tenantId, productId, reason, TODO_D_DEF_001_INTERVAL],
    );

    alertPayload = {
      tenantId,
      productId,
      reason,
      suspended_at: updated[0]!.suspended_at,
      grace_expires_at: updated[0]!.grace_expires_at,
    };

    await client.query('COMMIT');
    logger.info({ tenant_id: tenantId, product_id: productId, reason }, 'License suspended: active → suspended');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Post-commit: alert fires after client is released; never blocks FSM (D-001)
  if (alertPayload) {
    await emitBelowFloorAlert(alertPayload);
  }
}

// ── freezeLicense ─────────────────────────────────────────────────────────────

export async function freezeLicense(
  tenantId: string,
  productId: string,
): Promise<void> {
  // D-006: per-product scope — only this (tenantId, productId) is affected; siblings unmodified
  return suspendLicense(tenantId, productId, 'FREEZE');
}

// ── unfreezeProduct ───────────────────────────────────────────────────────────
// Admin override: transitions suspended → active without touching Stripe or grace periods.
// Called by the admin console freeze DELETE endpoint (HUB-1496 / E27).

export async function unfreezeProduct(tenantId: string, productId: string): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query<LicenseRow>(
      `SELECT id, status FROM licenses
       WHERE tenant_id = $1 AND product_id = $2
       FOR UPDATE`,
      [tenantId, productId],
    );
    if (rows.length === 0) throw new AppError(404, 'License not found');
    if (rows[0]!.status !== 'suspended') throw new AppError(422, 'License is not suspended');

    await client.query(
      `UPDATE licenses
       SET status = 'active',
           reason = NULL,
           suspended_at = NULL,
           grace_expires_at = NULL,
           updated_at = NOW()
       WHERE tenant_id = $1 AND product_id = $2`,
      [tenantId, productId],
    );

    await client.query('COMMIT');
    logger.info({ tenant_id: tenantId, product_id: productId }, 'License unfrozen: suspended → active (admin override)');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── cancelLicense ─────────────────────────────────────────────────────────────

export async function cancelLicense(
  tenantId: string,
  productId: string,
): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query<LicenseRow>(
      `SELECT id, status FROM licenses
       WHERE tenant_id = $1 AND product_id = $2
       FOR UPDATE`,
      [tenantId, productId],
    );
    if (rows.length === 0) throw new AppError(404, 'License not found');
    if (rows[0]!.status !== 'suspended') throw new AppError(422, 'License is not in suspended state');

    await client.query(
      `UPDATE licenses SET status = 'cancelled', reason = NULL, updated_at = NOW()
       WHERE tenant_id = $1 AND product_id = $2`,
      [tenantId, productId],
    );

    await client.query('COMMIT');
    logger.info({ tenant_id: tenantId, product_id: productId }, 'License cancelled: suspended → cancelled (terminal)');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── getLicenseStatus ──────────────────────────────────────────────────────────

export async function getLicenseStatus(
  tenantId: string,
  productId: string,
): Promise<GetLicenseStatusResult> {
  const pool = getPool();
  const { rows } = await pool.query<{
    status: LicenseStatus;
    grace_expires_at: Date | null;
    slc_new_status: string | null;
    slc_staged_at: Date | null;
  }>(
    `SELECT l.status,
            l.grace_expires_at,
            slc.new_status AS slc_new_status,
            slc.staged_at  AS slc_staged_at
     FROM licenses l
     LEFT JOIN staged_license_changes slc
       ON slc.license_id = l.id AND slc.promoted_at IS NULL
     WHERE l.tenant_id = $1 AND l.product_id = $2
     ORDER BY slc.staged_at DESC NULLS LAST
     LIMIT 1`,
    [tenantId, productId],
  );

  if (rows.length === 0) throw new AppError(404, 'License not found');

  const row = rows[0]!;
  const result: GetLicenseStatusResult = {
    status: row.status,
    grace_expires_at: row.grace_expires_at,
  };
  if (row.slc_new_status !== null && row.slc_staged_at !== null) {
    result.staged_change = { new_status: row.slc_new_status, staged_at: row.slc_staged_at };
  }
  return result;
}

// ── promoteStagedLicenseChanges ───────────────────────────────────────────────
// BullMQ CRON processor: each unpromoted staged change promoted in its own
// transaction to limit lock contention; partial failure continues to next row.

export async function promoteStagedLicenseChanges(): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string; license_id: string; new_status: string }>(
    `SELECT id, license_id, new_status
     FROM staged_license_changes
     WHERE promoted_at IS NULL AND staged_at <= NOW()`,
  );

  logger.info({ count: rows.length }, 'CRON: promoting staged license changes');

  for (const staged of rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE licenses SET status = $1, updated_at = NOW() WHERE id = $2`,
        [staged.new_status, staged.license_id],
      );
      await client.query(
        `UPDATE staged_license_changes SET promoted_at = NOW() WHERE id = $1`,
        [staged.id],
      );
      await client.query('COMMIT');
      logger.info(
        { staged_id: staged.id, license_id: staged.license_id, new_status: staged.new_status },
        'Staged license change promoted',
      );
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error(
        { err, staged_id: staged.id, license_id: staged.license_id },
        'CRON: staged change promotion failed — continuing',
      );
    } finally {
      client.release();
    }
  }
}

// ── emitBelowFloorAlert ───────────────────────────────────────────────────────
// D-001 resolved = alert-only; never throws; never blocks the FSM or caller.

export async function emitBelowFloorAlert(payload: BelowFloorAlertPayload): Promise<void> {
  try {
    // TODO: replace with BullMQ job or outbound HTTP when alert routing is decided
    logger.info(
      { tenantId: payload.tenantId, productId: payload.productId, reason: payload.reason },
      'below_floor alert emitted',
    );
  } catch (err) {
    logger.warn(
      { err, tenantId: payload.tenantId, productId: payload.productId },
      'below_floor alert dispatch failed',
    );
  }
}
