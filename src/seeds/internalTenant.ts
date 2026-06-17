// Authorized by HUB-1087 — seedInternalTenant; idempotent INSERT ON CONFLICT DO NOTHING
import type { Pool } from 'pg';

// UUID matches MAVERICK_LAUNCH_TENANT_ID constant established in migration 001_core_platform_tables
const MAVERICK_LAUNCH_ID = '00000000-0000-0000-0000-000000000001';

export async function seedInternalTenant(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO tenants (id, name, tenant_type, active)
     VALUES ($1, 'Maverick Launch', 'internal', true)
     ON CONFLICT DO NOTHING`,
    [MAVERICK_LAUNCH_ID],
  );
}
