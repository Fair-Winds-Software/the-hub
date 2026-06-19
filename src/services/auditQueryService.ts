// Authorized by HUB-1518 — queryAuditLog; cursor pagination; tenant scoping; 90-day max range

import { getPool } from "../db/pool.js";
import { AppError } from "../errors/AppError.js";

const MAX_RANGE_DAYS = 90;
const MAX_LIMIT = 200;

export interface AuditQueryParams {
  tenant_id: string;
  table_name?: string;
  operation?: string;
  from: Date;
  to: Date;
  limit: number;
  cursor?: string;
}

export interface AuditRow {
  id: string;
  tenant_id: string;
  product_id: string | null;
  actor_id: string | null;
  actor_type: string | null;
  operation: string;
  table_name: string;
  record_id: string | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  delta_data: Record<string, unknown> | null;
  ip_address: string | null;
  trace_id: string | null;
  occurred_at: string;
  created_at: string;
}

interface CursorPayload {
  created_at: string;
  id: string;
}

export function encodeCursor(created_at: string, id: string): string {
  return Buffer.from(JSON.stringify({ created_at, id })).toString("base64url");
}

function decodeCursor(raw: string): CursorPayload {
  try {
    return JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as CursorPayload;
  } catch {
    throw new AppError(400, "Invalid cursor");
  }
}

export async function queryAuditLog(params: AuditQueryParams): Promise<{
  from: string;
  to: string;
  generated_at: string;
  row_count: number;
  next_cursor: string | null;
  data: AuditRow[];
}> {
  const rangeDays =
    (params.to.getTime() - params.from.getTime()) / (1000 * 60 * 60 * 24);
  if (rangeDays > MAX_RANGE_DAYS) {
    throw new AppError(400, "Time range must not exceed 90 days");
  }

  const limit = Math.min(params.limit, MAX_LIMIT);
  const conditions: string[] = [
    "tenant_id = $1",
    "created_at >= $2",
    "created_at <= $3",
  ];
  const values: unknown[] = [params.tenant_id, params.from, params.to];
  let idx = 4;

  if (params.table_name) {
    conditions.push(`table_name = $${idx++}`);
    values.push(params.table_name);
  }
  if (params.operation) {
    conditions.push(`operation = $${idx++}`);
    values.push(params.operation);
  }

  if (params.cursor) {
    const { created_at, id } = decodeCursor(params.cursor);
    // Keyset pagination: exclude rows at or before the cursor position
    conditions.push(
      `(created_at, id) < ($${idx++}::timestamptz, $${idx++}::uuid)`,
    );
    values.push(created_at, id);
  }

  const where = conditions.join(" AND ");
  const fetchLimit = limit + 1;

  const { rows } = await getPool().query<AuditRow>(
    `SELECT id, tenant_id, product_id, actor_id, actor_type, operation, table_name,
            record_id, old_values, new_values, delta_data, ip_address, trace_id,
            occurred_at, created_at
       FROM audit_log
      WHERE ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT $${idx}`,
    [...values, fetchLimit],
  );

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  const next_cursor =
    hasMore && last ? encodeCursor(String(last.created_at), last.id) : null;

  return {
    from: params.from.toISOString(),
    to: params.to.toISOString(),
    generated_at: new Date().toISOString(),
    row_count: data.length,
    next_cursor,
    data,
  };
}
