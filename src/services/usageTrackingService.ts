// Authorized by HUB-622 — recordUsageEvent; pg transaction; idempotency via ON CONFLICT DO NOTHING
import { getPool } from '../db/pool.js';
import logger from '../lib/logger.js';
import { getActivePricingModel } from './pricingModelService.js';
import { computeCost } from '../lib/computeCost.js';

export interface UsageEventInput {
  event_type: string;
  unit_count: number;
  occurred_at: string;
  idempotency_key?: string;
}

export interface UsageEventResult {
  event_id: string;
  cost_cents: number;
  duplicate: boolean;
}

const LATE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export async function recordUsageEvent(
  tenantId: string,
  productId: string,
  input: UsageEventInput,
): Promise<UsageEventResult> {
  const pool = getPool();
  const client = await pool.connect();

  const occurredAt = new Date(input.occurred_at);
  const ingested_late = Date.now() - occurredAt.getTime() > LATE_THRESHOLD_MS;

  try {
    await client.query('BEGIN');

    const { rows: eventRows } = await client.query<{ id: string }>(
      `INSERT INTO usage_events
         (tenant_id, product_id, event_type, unit_count, occurred_at, ingested_late, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
        tenantId,
        productId,
        input.event_type,
        input.unit_count,
        occurredAt.toISOString(),
        ingested_late,
        input.idempotency_key ?? null,
      ],
    );

    if (eventRows.length === 0) {
      await client.query('ROLLBACK');
      return { event_id: '', cost_cents: 0, duplicate: true };
    }

    const eventId = eventRows[0]!.id;

    const pricingModel = await getActivePricingModel(productId);
    const cost_cents = pricingModel ? computeCost(pricingModel, input.unit_count) : 0;

    await client.query(
      `INSERT INTO cost_ledger
         (usage_event_id, tenant_id, product_id, pricing_model_id, cost_cents, occurred_at, ingested_late)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        eventId,
        tenantId,
        productId,
        pricingModel?.model_id ?? null,
        cost_cents,
        occurredAt.toISOString(),
        ingested_late,
      ],
    );

    await client.query('COMMIT');

    logger.info({ tenantId, productId, eventId, cost_cents }, 'Usage event recorded');

    return { event_id: eventId, cost_cents, duplicate: false };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
