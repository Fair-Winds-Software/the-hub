// Authorized by HUB-1524 — monthly data retention: audit_log (36-month) + cost_ledger (RETAIN_MONTHS) pruning

import { getPool } from '../db/pool.js';
import logger from '../lib/logger.js';
import { writeAuditEntry } from '../services/auditLogService.js';

const AUDIT_LOG_RETAIN_MONTHS = 36;
const DEFAULT_COST_LEDGER_RETAIN_MONTHS = 24;
const MIN_RETAIN_MONTHS_WARN = 6;

export function getRetainMonths(): number {
  const raw = process.env['RETAIN_MONTHS'];
  if (!raw) return DEFAULT_COST_LEDGER_RETAIN_MONTHS;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed <= 0) {
    logger.warn({ raw }, 'RETAIN_MONTHS is invalid — using default 24 months');
    return DEFAULT_COST_LEDGER_RETAIN_MONTHS;
  }
  if (parsed < MIN_RETAIN_MONTHS_WARN) {
    logger.warn({ months: parsed }, 'RETAIN_MONTHS is below recommended minimum of 6 months');
  }
  return parsed;
}

export async function runAuditLogRetention(): Promise<void> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM audit_log
      WHERE created_at < NOW() - INTERVAL '${AUDIT_LOG_RETAIN_MONTHS} months'`,
  );
  const pruned = rowCount ?? 0;

  logger.info({ pruned, retain_months: AUDIT_LOG_RETAIN_MONTHS }, 'audit_log_retention_complete');

  // Audit the pruning itself — operation='SYSTEM_PRUNE' with count in delta_data
  await writeAuditEntry({
    tenant_id: '00000000-0000-0000-0000-000000000000',
    actor_id: 'system',
    actor_type: 'system',
    operation: 'SYSTEM_PRUNE',
    table_name: 'audit_log',
    delta_data: { pruned_rows: pruned, retain_months: AUDIT_LOG_RETAIN_MONTHS },
  });
}

export async function runCostLedgerRetention(): Promise<void> {
  const retainMonths = getRetainMonths();
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM cost_ledger
      WHERE occurred_at < NOW() - INTERVAL '${retainMonths} months'`,
  );
  const pruned = rowCount ?? 0;

  logger.info({ pruned, retain_months: retainMonths }, 'cost_ledger_retention_complete');
}
