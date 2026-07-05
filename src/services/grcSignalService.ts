// Authorized by HUB-1385 (E-CMP-WAVE4 S2, HUB-870) — reusable signal-emission helper
// for GRC-Lite Wave 4 register completion events. Resolves the operator-supplied
// product slug + the seeded control_id string to their UUID references, then
// INSERTs into compliance_signal_evidence (the immutable-append-only signal log
// added by HUB-1020). Runs inside the caller's transaction so a signal insert
// and its primary record write commit atomically.
//
// Design points:
//   * Missing product/control lookup does NOT throw — logs a warn and returns
//     `{ emitted: false, reason }`. The primary record must still commit; a stale
//     product slug shouldn't rollback a valid attestation.
//   * `signal_id` is the caller-provided entity id (record UUID). That guarantees
//     (product_id, signal_id) UNIQUE never collides across replays for the same
//     record — matching the compliance_signal_evidence dedup contract.
//   * `content_hash` = sha256(entity_id + signal_type + observed_at) — same tamper
//     evidence pattern used by other compliance emitters.

import type { PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import logger from '../lib/logger.js';

export interface EmitSignalInput {
  productSlug: string;
  controlKey: string;
  signalType: string;
  entityId: string;
  payload: Record<string, unknown>;
  observedAt?: Date;
}

export type EmitSignalResult =
  | { emitted: true; signalEvidenceId: string }
  | { emitted: false; reason: 'unknown_product' | 'unknown_control' };

export async function emitGrcSignal(
  client: PoolClient,
  input: EmitSignalInput,
): Promise<EmitSignalResult> {
  const { productSlug, controlKey, signalType, entityId, payload } = input;
  const observedAt = input.observedAt ?? new Date();

  const { rows: productRows } = await client.query<{ id: string }>(
    `SELECT id FROM products WHERE slug = $1 LIMIT 1`,
    [productSlug],
  );
  const productId = productRows[0]?.id;
  if (!productId) {
    logger.warn(
      { event: 'grc.signal.skipped', reason: 'unknown_product', productSlug, controlKey, signalType, entityId },
      'GRC signal skipped — product slug not found in products.slug',
    );
    return { emitted: false, reason: 'unknown_product' };
  }

  const { rows: controlRows } = await client.query<{ id: string }>(
    `SELECT id FROM compliance_controls WHERE control_id = $1 LIMIT 1`,
    [controlKey],
  );
  const controlUuid = controlRows[0]?.id;
  if (!controlUuid) {
    logger.warn(
      { event: 'grc.signal.skipped', reason: 'unknown_control', productSlug, controlKey, signalType, entityId },
      'GRC signal skipped — control_id not found in compliance_controls',
    );
    return { emitted: false, reason: 'unknown_control' };
  }

  const contentHash = createHash('sha256')
    .update(`${entityId}|${signalType}|${observedAt.toISOString()}`)
    .digest('hex');

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO compliance_signal_evidence
       (product_id, control_id, signal_id, content_hash, payload, signal_type, observed_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
     RETURNING id`,
    [productId, controlUuid, entityId, contentHash, JSON.stringify(payload), signalType, observedAt.toISOString()],
  );

  return { emitted: true, signalEvidenceId: rows[0]!.id };
}
