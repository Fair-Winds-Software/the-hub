// Authorized by HUB-1517 — writeAuditEntry; sensitive field redaction; never-throws contract

import { getPool } from "../db/pool.js";
import logger from "../lib/logger.js";

const REDACT_FIELDS = new Set([
  "client_secret_hash",
  "password_hash",
  "secret",
  "token",
]);

export interface AuditEntry {
  tenant_id: string;
  product_id?: string | null;
  actor_id?: string | null;
  actor_type?: string | null;
  operation: "INSERT" | "UPDATE" | "DELETE";
  table_name: string;
  record_id?: string | null;
  old_values?: Record<string, unknown> | null;
  new_values?: Record<string, unknown> | null;
  delta_data?: Record<string, unknown> | null;
  ip_address?: string | null;
  trace_id?: string | null;
  occurred_at?: Date;
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
          old_values, new_values, delta_data, ip_address, trace_id, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
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
      ],
    );
  } catch (err: unknown) {
    logger.error(
      { err, table_name: entry.table_name, operation: entry.operation },
      "writeAuditEntry failed",
    );
  }
}
