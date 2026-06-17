// Authorized by HUB-822 — hook matching service; OR-NULL wildcard SQL pattern for tenant_id / product_id
import { getPool } from '../db/pool.js';

export interface WorkflowHook {
  id: string;
  tenant_id: string | null;
  product_id: string | null;
  trigger_event_type: string;
  action_type: string;
  action_config: { url: string; hmac_secret: string; [key: string]: unknown };
  enabled: boolean;
  created_at: string;
}

export async function findMatchingHooks(
  eventType: string,
  tenantId: string,
  productId: string,
): Promise<WorkflowHook[]> {
  const pool = getPool();
  const { rows } = await pool.query<WorkflowHook>(
    `SELECT id, tenant_id, product_id, trigger_event_type, action_type, action_config, enabled, created_at
     FROM workflow_hooks
     WHERE trigger_event_type = $1
       AND (tenant_id IS NULL OR tenant_id = $2)
       AND (product_id IS NULL OR product_id = $3)
       AND enabled = true
     ORDER BY created_at ASC`,
    [eventType, tenantId, productId],
  );
  return rows;
}
