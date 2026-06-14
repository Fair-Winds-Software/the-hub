// Authorized by HUB-300 — evaluateGate(); FSM-aware gate resolution chain
// Authorized by HUB-301 — setKillSwitch, setTenantFeatureOverride; Redis pub/sub broadcast
// Authorized by HUB-314 — getAllGateSnapshot(); batch gate evaluation for lease embedding
import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';
import logger from '../lib/logger.js';
import { getRedisClient } from '../redis/client.js';
import { getLicenseStatus } from './license.js';

export type GateSource = 'kill_switch' | 'license_suspended' | 'tenant_override' | 'default';

export interface GateEvalResult {
  enabled: boolean;
  source: GateSource;
}

// ── evaluateGate ──────────────────────────────────────────────────────────────

export async function evaluateGate(
  tenantId: string,
  productId: string,
  gateKey: string,
): Promise<GateEvalResult> {
  const pool = getPool();

  const { rows: gateRows } = await pool.query<{
    id: string;
    default_enabled: boolean;
    kill_switch_active: boolean;
  }>(
    `SELECT id, default_enabled, kill_switch_active
     FROM feature_gates
     WHERE product_id = $1 AND gate_key = $2`,
    [productId, gateKey],
  );
  if (gateRows.length === 0) throw new AppError(404, 'Feature gate not found');
  const gate = gateRows[0]!;

  if (gate.kill_switch_active) {
    return { enabled: false, source: 'kill_switch' };
  }

  const licenseStatus = await getLicenseStatus(tenantId, productId);
  if (licenseStatus.status === 'suspended' || licenseStatus.status === 'cancelled') {
    return { enabled: false, source: 'license_suspended' };
  }

  const { rows: overrideRows } = await pool.query<{ enabled: boolean }>(
    `SELECT enabled
     FROM tenant_feature_overrides
     WHERE tenant_id = $1 AND product_id = $2 AND gate_key = $3`,
    [tenantId, productId, gateKey],
  );
  if (overrideRows.length > 0) {
    return { enabled: overrideRows[0]!.enabled, source: 'tenant_override' };
  }

  return { enabled: gate.default_enabled, source: 'default' };
}

// ── setKillSwitch ─────────────────────────────────────────────────────────────

export async function setKillSwitch(
  productId: string,
  gateKey: string,
  enabled: boolean,
  reason: string | null,
  operatorId: string,
): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM feature_gates WHERE product_id = $1 AND gate_key = $2 FOR UPDATE`,
      [productId, gateKey],
    );
    if (rows.length === 0) throw new AppError(404, 'Feature gate not found');

    await client.query(
      `UPDATE feature_gates
       SET kill_switch_active = $1,
           kill_switch_reason = $2,
           kill_switch_set_at = CASE WHEN $1 THEN NOW() ELSE NULL END,
           kill_switch_set_by = CASE WHEN $1 THEN $3 ELSE NULL END,
           updated_at = NOW()
       WHERE product_id = $4 AND gate_key = $5`,
      [enabled, enabled ? reason : null, operatorId, productId, gateKey],
    );

    await client.query('COMMIT');
    logger.info({ productId, gateKey, enabled, operatorId }, 'Kill switch updated');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Post-commit: broadcast gate change invalidation signal (fire-and-forget)
  try {
    const redis = getRedisClient();
    await redis.publish(
      `hub:settings:gates:${productId}`,
      JSON.stringify({ type: 'gate_change', productId, gateKey }),
    );
  } catch (err) {
    logger.warn({ err, productId, gateKey }, 'Gate change broadcast failed');
  }
}

// ── setTenantFeatureOverride ──────────────────────────────────────────────────

export async function setTenantFeatureOverride(
  tenantId: string,
  productId: string,
  gateKey: string,
  enabled: boolean,
  reason: string | null,
  operatorId: string,
): Promise<void> {
  const pool = getPool();

  const { rows: gateRows } = await pool.query<{ id: string }>(
    `SELECT id FROM feature_gates WHERE product_id = $1 AND gate_key = $2`,
    [productId, gateKey],
  );
  if (gateRows.length === 0) throw new AppError(404, 'Feature gate not found');

  await pool.query(
    `INSERT INTO tenant_feature_overrides
       (tenant_id, product_id, gate_key, enabled, override_reason, set_by, set_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (tenant_id, product_id, gate_key)
     DO UPDATE SET
       enabled = EXCLUDED.enabled,
       override_reason = EXCLUDED.override_reason,
       set_by = EXCLUDED.set_by,
       set_at = NOW()`,
    [tenantId, productId, gateKey, enabled, reason, operatorId],
  );

  logger.info({ tenantId, productId, gateKey, enabled, operatorId }, 'Tenant feature override set');

  // Post-commit: broadcast gate change invalidation signal (fire-and-forget)
  try {
    const redis = getRedisClient();
    await redis.publish(
      `hub:settings:gates:${productId}`,
      JSON.stringify({ type: 'gate_change', productId, gateKey }),
    );
  } catch (err) {
    logger.warn({ err, productId, gateKey }, 'Gate change broadcast failed');
  }
}

// ── getAllGateSnapshot ────────────────────────────────────────────────────────

export async function getAllGateSnapshot(
  tenantId: string,
  productId: string,
): Promise<Record<string, boolean>> {
  const pool = getPool();

  const [gateResult, overrideResult, licenseStatus] = await Promise.all([
    pool.query<{ gate_key: string; default_enabled: boolean; kill_switch_active: boolean }>(
      `SELECT gate_key, default_enabled, kill_switch_active
       FROM feature_gates WHERE product_id = $1`,
      [productId],
    ),
    pool.query<{ gate_key: string; enabled: boolean }>(
      `SELECT gate_key, enabled
       FROM tenant_feature_overrides WHERE tenant_id = $1 AND product_id = $2`,
      [tenantId, productId],
    ),
    getLicenseStatus(tenantId, productId),
  ]);

  if (gateResult.rows.length === 0) return {};

  const licenseBlocked =
    licenseStatus.status === 'suspended' || licenseStatus.status === 'cancelled';

  const overrideMap = new Map<string, boolean>(
    overrideResult.rows.map((r) => [r.gate_key, r.enabled]),
  );

  const snapshot: Record<string, boolean> = {};
  for (const gate of gateResult.rows) {
    if (gate.kill_switch_active) {
      snapshot[gate.gate_key] = false;
    } else if (licenseBlocked) {
      snapshot[gate.gate_key] = false;
    } else {
      const override = overrideMap.get(gate.gate_key);
      snapshot[gate.gate_key] = override !== undefined ? override : gate.default_enabled;
    }
  }
  return snapshot;
}
