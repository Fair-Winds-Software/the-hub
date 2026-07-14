// Authorized by HUB-1805 (S3 of HUB-1785) — validate + persist a batch of metric_events.
// Every event walks a strict pipeline:
//
//   1. Wire schema (MetricEventInput from S1) — malformed → dropped with reason.
//   2. Catalog check — unknown metric_name → dropped with an 'unknown_metric' audit
//      trail (via the caller); never throws — dropping is the correct signal that we
//      need to grow the catalog explicitly.
//   3. Value type check per catalog entry (int / float / enum:v1|v2|...) — mismatched
//      type → dropped with reason.
//   4. occurred_at freshness — must be within [now - 30d, now + 5m] (5m tolerates
//      minor client clock skew) — otherwise dropped.
//   5. product_id existence — caller-supplied product-existence check (dependency-
//      injected so tests don't need PG). Unknown product → dropped.
//   6. Valid events INSERTed in a single transaction so a mid-batch failure rolls
//      back everything. Response counts accepted + per-event drop reasons.
import type { PoolClient } from 'pg';
import { getPool } from '../../db/pool.js';
import {
  filterDimensions,
  getCatalogEntry,
  MetricEventInput,
  validateValue,
  type MetricCatalogEntry,
} from './metricCatalog.js';

const MIN_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_FUTURE_MS = 5 * 60 * 1000; // 5 minutes clock-skew tolerance

export interface IngestDropReason {
  index: number;
  metric_name?: string;
  reason: string;
  category: 'schema' | 'unknown_metric' | 'value_type' | 'timestamp' | 'unknown_product';
}

export interface IngestResult {
  accepted: number;
  dropped: IngestDropReason[];
}

export interface IngestOptions {
  events: unknown[];
  /** Returns the subset of product_ids that exist in `products`. Injected for tests. */
  productExistenceCheck: (productIds: string[]) => Promise<Set<string>>;
  /** Optional clock override for the 30d/5m window test. Defaults to new Date(). */
  now?: Date;
}

interface ValidatedEvent {
  productId: string;
  metricName: string;
  entry: MetricCatalogEntry;
  dimensions: Record<string, string>;
  valueNum: number | null;
  valueStr: string | null;
  occurredAt: Date;
}

export async function ingestMetricBatch(opts: IngestOptions): Promise<IngestResult> {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const dropped: IngestDropReason[] = [];
  const valid: ValidatedEvent[] = [];

  // ── First pass: schema + catalog + value + timestamp validation ────────────
  for (let i = 0; i < opts.events.length; i += 1) {
    const raw = opts.events[i];
    const parsed = MetricEventInput.safeParse(raw);
    if (!parsed.success) {
      dropped.push({
        index: i,
        reason: parsed.error.issues.map((iss) => `${iss.path.join('.')}: ${iss.message}`).join('; '),
        category: 'schema',
      });
      continue;
    }
    const event = parsed.data;

    const entry = getCatalogEntry(event.metric_name);
    if (!entry) {
      dropped.push({
        index: i,
        metric_name: event.metric_name,
        reason: `unknown metric_name '${event.metric_name}' — not in catalog`,
        category: 'unknown_metric',
      });
      continue;
    }

    const valueCheck = validateValue(entry, event.value);
    if (!valueCheck.ok) {
      dropped.push({
        index: i,
        metric_name: event.metric_name,
        reason: valueCheck.reason,
        category: 'value_type',
      });
      continue;
    }

    const occurredAt = new Date(event.occurred_at);
    const ageMs = nowMs - occurredAt.getTime();
    if (ageMs > MIN_AGE_MS) {
      dropped.push({
        index: i,
        metric_name: event.metric_name,
        reason: `occurred_at is more than 30 days in the past`,
        category: 'timestamp',
      });
      continue;
    }
    if (ageMs < -MAX_FUTURE_MS) {
      dropped.push({
        index: i,
        metric_name: event.metric_name,
        reason: `occurred_at is more than 5 minutes in the future`,
        category: 'timestamp',
      });
      continue;
    }

    valid.push({
      productId: event.product_id,
      metricName: event.metric_name,
      entry,
      dimensions: filterDimensions(entry, event.dimensions),
      valueNum: valueCheck.value_num,
      valueStr: valueCheck.value_str,
      occurredAt,
    });
  }

  if (valid.length === 0) {
    return { accepted: 0, dropped };
  }

  // ── Second pass: product-existence bulk check ──────────────────────────────
  const uniqueProductIds = Array.from(new Set(valid.map((v) => v.productId)));
  const existing = await opts.productExistenceCheck(uniqueProductIds);

  const persistable: ValidatedEvent[] = [];
  for (let vi = 0; vi < valid.length; vi += 1) {
    const v = valid[vi]!;
    if (existing.has(v.productId)) {
      persistable.push(v);
    } else {
      // Find the original index — walk the input array by matching. We rely on order
      // to be preserved through Zod parsing so this is O(n^2) worst case but batches
      // are small (dozens, not thousands).
      const originalIndex = opts.events.findIndex((raw) => {
        if (raw === null || typeof raw !== 'object') return false;
        const r = raw as Record<string, unknown>;
        return (
          r['product_id'] === v.productId &&
          r['metric_name'] === v.metricName &&
          r['occurred_at'] === v.occurredAt.toISOString()
        );
      });
      dropped.push({
        index: originalIndex >= 0 ? originalIndex : -1,
        metric_name: v.metricName,
        reason: `unknown product_id '${v.productId}'`,
        category: 'unknown_product',
      });
    }
  }

  if (persistable.length === 0) {
    return { accepted: 0, dropped };
  }

  // ── Third pass: single transaction INSERT ──────────────────────────────────
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await insertBatch(client, persistable);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { accepted: persistable.length, dropped };
}

async function insertBatch(client: PoolClient, batch: ValidatedEvent[]): Promise<void> {
  // Parameterized multi-row insert. Column order:
  //   product_id, metric_name, dimensions, value_num, value_str, occurred_at
  const values: unknown[] = [];
  const rows: string[] = [];
  for (let i = 0; i < batch.length; i += 1) {
    const e = batch[i]!;
    const b = i * 6;
    rows.push(`($${b + 1}, $${b + 2}, $${b + 3}::jsonb, $${b + 4}, $${b + 5}, $${b + 6})`);
    values.push(
      e.productId,
      e.metricName,
      JSON.stringify(e.dimensions),
      e.valueNum,
      e.valueStr,
      e.occurredAt,
    );
  }
  await client.query(
    `INSERT INTO metric_events
       (product_id, metric_name, dimensions, value_num, value_str, occurred_at)
     VALUES ${rows.join(', ')}`,
    values,
  );
}
