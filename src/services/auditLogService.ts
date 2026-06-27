// Authorized by HUB-1517 — writeAuditEntry; sensitive field redaction; never-throws contract
// Authorized by HUB-1704 — event_type field (non-CRUD auth audit events); REDACT_FIELDS includes
// 'password' for login.failure audit entries that record the attempted email.
// Authorized by HUB-1598 (E-BE-1 S15) — added 'analytics.pricing_scenario_compute' to the
// non-CRUD event_type union (compute action, no DB write — mirrors auth audit pattern).
// Authorized by HUB-1695 (E-BE-1 S18) — added 'auth.session.revoke_pending' for the anonymous
// idempotent revoke-pending endpoint (system-initiated logout retry, distinct from
// 'auth.logout' which is user-initiated).

import { getPool } from "../db/pool.js";
import logger from "../lib/logger.js";

const REDACT_FIELDS = new Set([
  "client_secret_hash",
  "password_hash",
  "password",
  "secret",
  "token",
]);

export type AuditEventType =
  | "auth.login.success"
  | "auth.login.failure"
  | "auth.logout"
  | "auth.refresh_token.revoked"
  | "auth.session.revoke_pending"
  | "analytics.pricing_scenario_compute";

export interface AuditEntry {
  tenant_id: string;
  product_id?: string | null;
  actor_id?: string | null;
  actor_type?: string | null;
  operation: "INSERT" | "UPDATE" | "DELETE" | "SYSTEM_PRUNE";
  table_name: string;
  record_id?: string | null;
  old_values?: Record<string, unknown> | null;
  new_values?: Record<string, unknown> | null;
  delta_data?: Record<string, unknown> | null;
  ip_address?: string | null;
  trace_id?: string | null;
  occurred_at?: Date;
  /**
   * HUB-1704: non-CRUD event classifier. Populated for auth flows
   * (login.success / login.failure / logout / refresh_token.revoked); NULL for
   * CRUD audit entries (which classify via `operation` + `table_name`).
   */
  event_type?: AuditEventType | null;
}

function redactSensitiveFields(
  values: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!values) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    out[key] = REDACT_FIELDS.has(key) ? "[REDACTED]" : value;
  }
  return out;
}

export { redactSensitiveFields as _redactSensitiveFields };

export async function writeAuditEntry(entry: AuditEntry): Promise<void> {
  try {
    const old_values = redactSensitiveFields(entry.old_values);
    const new_values = redactSensitiveFields(entry.new_values);

    await getPool().query(
      `INSERT INTO audit_log
         (tenant_id, product_id, actor_id, actor_type, operation, table_name, record_id,
          old_values, new_values, delta_data, ip_address, trace_id, occurred_at, event_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        entry.tenant_id,
        entry.product_id ?? null,
        entry.actor_id ?? null,
        entry.actor_type ?? null,
        entry.operation,
        entry.table_name,
        entry.record_id ?? null,
        old_values !== null ? JSON.stringify(old_values) : null,
        new_values !== null ? JSON.stringify(new_values) : null,
        entry.delta_data !== undefined && entry.delta_data !== null
          ? JSON.stringify(entry.delta_data)
          : null,
        entry.ip_address ?? null,
        entry.trace_id ?? null,
        entry.occurred_at ?? new Date(),
        entry.event_type ?? null,
      ],
    );
  } catch (err: unknown) {
    logger.error(
      { err, table_name: entry.table_name, operation: entry.operation },
      "writeAuditEntry failed",
    );
  }
}
