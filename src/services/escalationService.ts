// Authorized by HUB-788 — runEscalationScan(); query new alerts, match rules, idempotency via ON CONFLICT DO NOTHING, enqueue deliver
import { getPool } from '../db/pool.js';
import { getEscalationDeliverQueue } from '../queues/index.js';
import logger from '../lib/logger.js';

export async function runEscalationScan(): Promise<{ scanned: number; escalated: number }> {
  const pool = getPool();
  const now = Date.now();

  // Step 1: all unacknowledged new alerts ordered by age
  const { rows: alerts } = await pool.query<{
    id: string;
    product_id: string;
    alert_type: string;
    first_fired_at: Date;
    tenant_id: string;
  }>(`SELECT id, product_id, alert_type, first_fired_at, tenant_id
      FROM alert_events
      WHERE status = 'new'
      ORDER BY first_fired_at ASC`);

  let escalated = 0;

  // TODO: add LIMIT for batching when alert volume grows (v2)
  for (const alert of alerts) {
    // Step 2: matching escalation rules for this product + alert type
    const { rows: rules } = await pool.query<{
      id: string;
      tier: number;
      threshold_minutes: number;
      escalation_contacts: Array<{ type: string; value: string }>;
    }>(
      `SELECT id, tier, threshold_minutes, escalation_contacts
       FROM escalation_rules
       WHERE product_id = $1 AND alert_type = $2
       ORDER BY tier ASC`,
      [alert.product_id, alert.alert_type],
    );

    for (const rule of rules) {
      // Step 3: threshold check
      const elapsed = now - new Date(alert.first_fired_at).getTime();
      if (elapsed < rule.threshold_minutes * 60 * 1000) continue;

      // Step 4: idempotency — INSERT DO NOTHING; null RETURNING id means already fired
      const { rows: inserted } = await pool.query<{ id: string }>(
        `INSERT INTO escalation_events (alert_event_id, tier, fired_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (alert_event_id, tier) DO NOTHING
         RETURNING id`,
        [alert.id, rule.tier],
      );

      if (!inserted[0]?.id) continue;

      // Step 5: enqueue deliver job (after idempotency row written — crash-safe)
      await getEscalationDeliverQueue().add('escalation_deliver', {
        alertEventId: alert.id,
        tier: rule.tier,
        contacts: rule.escalation_contacts,
        alertType: alert.alert_type,
        tenantId: alert.tenant_id,
        productId: alert.product_id,
      });

      logger.info(
        { alertEventId: alert.id, tier: rule.tier, threshold_minutes: rule.threshold_minutes, tenantId: alert.tenant_id, productId: alert.product_id },
        'Escalation fired',
      );
      escalated++;
    }
  }

  return { scanned: alerts.length, escalated };
}
