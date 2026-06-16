// Authorized by HUB-707 — ingestAlert(): severity classification, dedup upsert, hub:queue:notifications:deliver enqueue
import { getPool } from '../db/pool.js';
import { getNotificationsDeliverQueue } from '../queues/index.js';
import { AppError } from '../errors/AppError.js';
import logger from '../lib/logger.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SEVERITY_MAP: Record<string, string> = {
  below_floor: 'warning',          // D-001: always fires, never blocks
  grace_period_expired: 'critical',
  payment_failed: 'critical',
  sdk_version_deprecated: 'info',
};

function classifySeverity(alertType: string): string {
  const severity = SEVERITY_MAP[alertType];
  if (!severity) throw new AppError(400, `Unknown alert type: ${alertType}`);
  return severity;
}

export interface IngestAlertInput {
  tenantId: string;
  productId: string;
  alertType: string;
  payload: Record<string, unknown>;
  dedupKey?: string;
}

export interface IngestAlertResult {
  alertId: string;
  isDedup: boolean;
  fireCount: number;
}

export async function ingestAlert(input: IngestAlertInput): Promise<IngestAlertResult> {
  const { tenantId, productId, alertType, payload, dedupKey } = input;

  if (!UUID_RE.test(tenantId)) throw new AppError(400, 'tenantId must be a valid UUID');
  if (!UUID_RE.test(productId)) throw new AppError(400, 'productId must be a valid UUID');

  // Severity classification before any DB call — throws 400 for unknown alertType (D-001 safe)
  const severity = classifySeverity(alertType);

  const pool = getPool();
  const client = await pool.connect();
  let alertId: string;
  let fireCount: number;

  try {
    // Upsert: partial unique index covers (tenant_id, product_id, alert_type, dedup_key) WHERE status='new' AND dedup_key IS NOT NULL
    // When dedupKey is null: always INSERT (null is excluded from the partial index — no conflict fires)
    const { rows } = await client.query<{ id: string; fire_count: number }>(
      `INSERT INTO alert_events
         (tenant_id, product_id, alert_type, severity, payload, dedup_key, first_fired_at, last_fired_at, fire_count)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW(), 1)
       ON CONFLICT (tenant_id, product_id, alert_type, dedup_key)
         WHERE status = 'new' AND dedup_key IS NOT NULL
       DO UPDATE SET
         fire_count    = alert_events.fire_count + 1,
         last_fired_at = NOW(),
         payload       = EXCLUDED.payload
       RETURNING id, fire_count`,
      [tenantId, productId, alertType, severity, JSON.stringify(payload), dedupKey ?? null],
    );
    const row = rows[0]!;
    alertId = row.id;
    fireCount = row.fire_count;
  } finally {
    client.release();
  }

  const isDedup = fireCount > 1;

  // Enqueue delivery job — DB write takes priority; log + continue if queue fails
  try {
    await getNotificationsDeliverQueue().add('deliver', { alertId, tenantId, productId, alertType, severity, fireCount });
  } catch (err) {
    logger.error(
      { err, alertId, tenantId, productId, alertType },
      'Failed to enqueue notification delivery — alert persisted for audit replay',
    );
  }

  return { alertId, isDedup, fireCount };
}
