// Authorized by HUB-1098 — alert rule resolution (product-specific override with platform-wide fallback)
// Authorized by HUB-1102 — deliverAlert(): notification log insert, email, in-app channel dispatch
// Authorized by HUB-1118 — fireControlFailureAlert(): PASS→FAIL transition alert
// Authorized by HUB-1353 — fireControlFailureAlert(): same engine, duplicate story resolved
// Authorized by HUB-1354 — runHumanEscalationScheduler(): T-7/T-1/T-0/overdue reminder cron
// Authorized by HUB-1355 — runDriftDetectionEngine(): 7-day posture score drop detection
import { createHash } from 'node:crypto';
import nodemailer from 'nodemailer';
import { getPool } from '../db/pool.js';
import logger from '../lib/logger.js';

type AlertType = 'control_failure' | 'human_overdue_reminder' | 'drift_detected';
type Severity = 'low' | 'medium' | 'high' | 'critical';

interface AlertInput {
  alertType: AlertType;
  severity: Severity;
  productId?: string;
  controlId?: string;
  payload: Record<string, unknown>;
  channels?: string[];
  contentHashSeed: string;
}

// ── Email transport ───────────────────────────────────────────────────────────

function createTransport() {
  if (process.env.ALERT_EMAIL_TRANSPORT === 'json' || process.env.NODE_ENV === 'test') {
    return nodemailer.createTransport({ jsonTransport: true });
  }
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? 'localhost',
    port: parseInt(process.env.SMTP_PORT ?? '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
}

function renderEmailBody(alertType: AlertType, payload: Record<string, unknown>): string {
  switch (alertType) {
    case 'control_failure':
      return `Compliance Alert: Control Failure\n\nControl: ${payload.control_key ?? 'unknown'}\nProduct: ${payload.product_id ?? 'unknown'}\nPrevious verdict: ${payload.previous_verdict ?? 'unknown'}\nNew verdict: fail\n\nImmediate investigation required.`;
    case 'human_overdue_reminder':
      return `Compliance Reminder: Human Control Due\n\nControl: ${payload.control_key ?? 'unknown'}\nProduct: ${payload.product_id ?? 'unknown'}\nDays until due: ${payload.days_until_due ?? 'unknown'}\n\nPlease complete attestation before the due date.`;
    case 'drift_detected':
      return `Compliance Alert: Posture Score Drift\n\nProduct: ${payload.product_id ?? 'platform-wide'}\nCurrent score: ${payload.current_score ?? 'unknown'}%\nScore 7 days ago: ${payload.previous_score ?? 'unknown'}%\nDrop: ${payload.drop ?? 'unknown'}%\n\nInvestigate recent changes that may have degraded compliance posture.`;
  }
}

// ── Core delivery function ────────────────────────────────────────────────────

export async function deliverAlert(input: AlertInput): Promise<{ notification_id: string; duplicate: boolean }> {
  const pool = getPool();
  const channels = input.channels ?? ['IN_APP'];

  const contentHash = createHash('sha256')
    .update(input.contentHashSeed)
    .digest('hex');

  // Insert notification (content_hash UNIQUE enforces dedup)
  const { rows, rowCount } = await pool.query<{ id: string }>(
    `INSERT INTO alert_notifications
       (product_id, control_id, alert_type, severity, payload, channels_targeted, content_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (content_hash) DO NOTHING
     RETURNING id`,
    [
      input.productId ?? null,
      input.controlId ?? null,
      input.alertType,
      input.severity,
      JSON.stringify(input.payload),
      channels,
      contentHash,
    ],
  );

  if (rowCount === 0) {
    return { notification_id: '', duplicate: true };
  }

  const notificationId = rows[0]!.id;

  // Dispatch email channel
  if (channels.includes('EMAIL')) {
    try {
      const transport = createTransport();
      const to = process.env.ALERT_EMAIL_TO ?? 'compliance@example.com';
      await transport.sendMail({
        from: process.env.ALERT_EMAIL_FROM ?? 'hub-alerts@example.com',
        to,
        subject: `[HUB Compliance] ${input.alertType} — ${input.severity.toUpperCase()}`,
        text: renderEmailBody(input.alertType, input.payload),
      });
    } catch (err) {
      logger.error({ err, notificationId }, 'Alert email dispatch failed — notification logged, email skipped');
    }
  }

  logger.info(
    { notificationId, alertType: input.alertType, severity: input.severity, channels },
    'Compliance alert delivered',
  );

  return { notification_id: notificationId, duplicate: false };
}

// ── Rule resolution ───────────────────────────────────────────────────────────

interface AlertRule {
  id: string;
  product_id: string | null;
  rule_type: string;
  threshold_value: number | null;
  escalation_delay_hours: number | null;
  assignee_account_id: string | null;
  fallback_assignee_account_id: string | null;
  enabled: boolean;
}

export async function getAlertRule(productId: string | null, ruleType: string): Promise<AlertRule | null> {
  const pool = getPool();
  // Product-specific rule takes priority over platform-wide (NULLS LAST ordering)
  const { rows } = await pool.query<AlertRule>(
    `SELECT id, product_id, rule_type, threshold_value, escalation_delay_hours,
            assignee_account_id, fallback_assignee_account_id, enabled
     FROM alert_rules
     WHERE rule_type = $1
       AND enabled = true
       AND (product_id = $2 OR product_id IS NULL)
     ORDER BY product_id NULLS LAST
     LIMIT 1`,
    [ruleType, productId],
  );
  return rows[0] ?? null;
}

// ── Control failure alert engine (HUB-1118 / HUB-1353) ───────────────────────

export async function fireControlFailureAlert(
  productId: string,
  controlId: string,
  controlKey: string,
  previousVerdict: string,
): Promise<void> {
  const rule = await getAlertRule(productId, 'control_failure');
  if (!rule) return;

  const today = new Date().toISOString().slice(0, 10);
  await deliverAlert({
    alertType: 'control_failure',
    severity: 'high',
    productId,
    controlId,
    payload: { product_id: productId, control_id: controlId, control_key: controlKey, previous_verdict: previousVerdict },
    channels: ['IN_APP', 'EMAIL'],
    // One alert per control per day — dedup via date + control key
    contentHashSeed: `control_failure:${controlId}:${productId}:${today}`,
  });
}

// ── Human escalation scheduler (HUB-1354) ────────────────────────────────────

export async function runHumanEscalationScheduler(): Promise<{ fired: number; skipped: number }> {
  const pool = getPool();
  const now = new Date();
  const today = now.toISOString().slice(0, 10); // YYYY-MM-DD

  // Find all human controls in enforced products
  const { rows: bindings } = await pool.query<{
    product_id: string;
    control_id: string;
    control_key: string;
    eval_cadence: string;
    last_signal_at: Date | null;
  }>(
    `SELECT b.product_id, c.id AS control_id, c.control_id AS control_key, c.eval_cadence,
            MAX(se.observed_at) AS last_signal_at
     FROM product_control_bindings b
     JOIN compliance_controls c ON c.id = b.control_id
     JOIN compliance_product_registrations cpr ON cpr.product_id = b.product_id AND cpr.burn_in_state = 'enforced'
     LEFT JOIN compliance_signal_evidence se
       ON se.product_id = b.product_id AND se.control_id = b.control_id AND se.is_burn_in_gap = false
     WHERE b.active = true AND c.active = true
       AND c.control_class = 'human'
     GROUP BY b.product_id, c.id, c.control_id, c.eval_cadence`,
  );

  const CADENCE_DAYS: Record<string, number> = {
    daily: 1,
    weekly: 7,
    monthly: 30,
    continuous: 1,
  };

  let fired = 0;
  let skipped = 0;

  for (const binding of bindings) {
    const cadenceDays = CADENCE_DAYS[binding.eval_cadence] ?? 7;
    const dueAt = binding.last_signal_at
      ? new Date(binding.last_signal_at.getTime() + cadenceDays * 24 * 60 * 60 * 1_000)
      : new Date(now.getTime() - cadenceDays * 24 * 60 * 60 * 1_000); // already overdue if no signal

    const daysUntilDue = Math.ceil((dueAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1_000));

    let reminderStage: string | null = null;
    let severity: Severity = 'medium';
    let alertType: AlertType = 'human_overdue_reminder';

    if (daysUntilDue <= 0) {
      reminderStage = 'overdue';
      severity = 'high';
    } else if (daysUntilDue === 1) {
      reminderStage = 'T-1';
    } else if (daysUntilDue === 7) {
      reminderStage = 'T-7';
      severity = 'low';
    }

    if (!reminderStage) {
      skipped++;
      continue;
    }

    const rule = await getAlertRule(binding.product_id, 'human_overdue');
    if (!rule) {
      skipped++;
      continue;
    }

    // DATE_TRUNC('day') in seed prevents double-firing within same calendar day
    const contentHashSeed = `human_overdue:${binding.control_id}:${binding.product_id}:${reminderStage}:${today}`;
    const result = await deliverAlert({
      alertType,
      severity,
      productId: binding.product_id,
      controlId: binding.control_id,
      payload: {
        product_id: binding.product_id,
        control_key: binding.control_key,
        reminder_stage: reminderStage,
        days_until_due: daysUntilDue,
        due_at: dueAt.toISOString(),
      },
      channels: ['IN_APP', 'EMAIL'],
      contentHashSeed,
    });

    if (result.duplicate) {
      skipped++;
    } else {
      fired++;
    }
  }

  logger.info({ fired, skipped }, 'Human escalation scheduler completed');
  return { fired, skipped };
}

// ── Drift detection engine (HUB-1355) ────────────────────────────────────────

export async function runDriftDetectionEngine(): Promise<{ fired: number; skipped: number }> {
  const pool = getPool();
  const today = new Date().toISOString().slice(0, 10);

  // Get current posture score per product
  const { rows: current } = await pool.query<{
    product_id: string;
    total: string;
    passed: string;
  }>(
    `SELECT cv.product_id,
            COUNT(*)                                      AS total,
            COUNT(*) FILTER (WHERE cv.verdict = 'pass')  AS passed
     FROM compliance_current_verdicts cv
     JOIN compliance_product_registrations cpr ON cpr.product_id = cv.product_id AND cpr.burn_in_state = 'enforced'
     GROUP BY cv.product_id`,
  );

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000);
  // ±1 day tolerance window
  const windowStart = new Date(sevenDaysAgo.getTime() - 24 * 60 * 60 * 1_000);
  const windowEnd = new Date(sevenDaysAgo.getTime() + 24 * 60 * 60 * 1_000);

  let fired = 0;
  let skipped = 0;

  for (const row of current) {
    const total = parseInt(row.total, 10);
    if (total === 0) { skipped++; continue; }
    const currentScore = (parseInt(row.passed, 10) / total) * 100;

    // Get the 7-day-ago score via DISTINCT ON with ±1 day tolerance
    const { rows: histRows } = await pool.query<{
      total_count: string;
      passed_count: string;
    }>(
      `WITH snapshot AS (
         SELECT DISTINCT ON (control_id)
           control_id, verdict
         FROM compliance_verdict_history
         WHERE product_id = $1
           AND evaluated_at BETWEEN $2 AND $3
         ORDER BY control_id, evaluated_at DESC
       )
       SELECT COUNT(*)                                     AS total_count,
              COUNT(*) FILTER (WHERE verdict = 'pass')     AS passed_count
       FROM snapshot`,
      [row.product_id, windowStart, windowEnd],
    );

    if (histRows.length === 0 || parseInt(histRows[0]!.total_count, 10) === 0) {
      skipped++;
      continue;
    }

    const prevTotal = parseInt(histRows[0]!.total_count, 10);
    const prevScore = (parseInt(histRows[0]!.passed_count, 10) / prevTotal) * 100;
    const drop = prevScore - currentScore;

    const rule = await getAlertRule(row.product_id, 'drift_detected');
    const threshold = rule?.threshold_value ?? 10;

    if (drop < threshold) {
      skipped++;
      continue;
    }

    // DATE_TRUNC('day') in seed prevents double-firing within same calendar day
    const contentHashSeed = `drift_detected:${row.product_id}:${today}`;
    const result = await deliverAlert({
      alertType: 'drift_detected',
      severity: 'high',
      productId: row.product_id,
      payload: {
        product_id: row.product_id,
        current_score: parseFloat(currentScore.toFixed(2)),
        previous_score: parseFloat(prevScore.toFixed(2)),
        drop: parseFloat(drop.toFixed(2)),
        threshold,
      },
      channels: ['IN_APP', 'EMAIL'],
      contentHashSeed,
    });

    if (result.duplicate) {
      skipped++;
    } else {
      fired++;
    }
  }

  logger.info({ fired, skipped }, 'Drift detection engine completed');
  return { fired, skipped };
}
