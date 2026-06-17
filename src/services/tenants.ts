// Authorized by HUB-1086 — createTenant, listTenants, getTenant, updateTenant, deactivateTenant
// Authorized by HUB-1127 — deactivateTenant cascade: atomically disables products in same pg tx
import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';

export interface TenantRecord {
  id: string;
  name: string;
  tenant_type: 'external' | 'internal';
  active: boolean;
  created_at: string;
  updated_at: string;
}

export async function createTenant(data: {
  name: string;
  tenant_type: 'external' | 'internal';
}): Promise<TenantRecord> {
  try {
    const { rows } = await getPool().query<TenantRecord>(
      `INSERT INTO tenants (id, name, tenant_type, active)
       VALUES (gen_random_uuid(), $1, $2, true)
       RETURNING id, name, tenant_type, active, created_at, updated_at`,
      [data.name, data.tenant_type],
    );
    return rows[0]!;
  } catch (err: unknown) {
    if ((err as { code?: string }).code === '23505') {
      throw new AppError(409, 'Tenant name already in use');
    }
    throw err;
  }
}

export async function listTenants(opts: {
  active?: boolean;
  tenant_type?: string;
} = {}): Promise<TenantRecord[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (opts.active !== undefined) {
    conditions.push(`active = $${i++}`);
    values.push(opts.active);
  }
  if (opts.tenant_type) {
    conditions.push(`tenant_type = $${i++}`);
    values.push(opts.tenant_type);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await getPool().query<TenantRecord>(
    `SELECT id, name, tenant_type, active, created_at, updated_at
       FROM tenants ${where}
      ORDER BY created_at ASC`,
    values,
  );
  return rows;
}

export async function getTenant(tenantId: string): Promise<TenantRecord> {
  const { rows } = await getPool().query<TenantRecord>(
    `SELECT id, name, tenant_type, active, created_at, updated_at
       FROM tenants WHERE id = $1`,
    [tenantId],
  );
  if (!rows[0]) throw new AppError(404, 'Tenant not found');
  return rows[0];
}

export async function updateTenant(
  tenantId: string,
  data: { name?: string; active?: boolean },
): Promise<TenantRecord> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (data.name !== undefined) {
    sets.push(`name = $${i++}`);
    values.push(data.name);
  }
  if (data.active !== undefined) {
    sets.push(`active = $${i++}`);
    values.push(data.active);
  }
  if (sets.length === 0) throw new AppError(400, 'Nothing to update');
  sets.push(`updated_at = NOW()`);
  values.push(tenantId);

  const { rows } = await getPool().query<TenantRecord>(
    `UPDATE tenants SET ${sets.join(', ')} WHERE id = $${i}
     RETURNING id, name, tenant_type, active, created_at, updated_at`,
    values,
  );
  if (!rows[0]) throw new AppError(404, 'Tenant not found');
  return rows[0];
}

export async function deactivateTenant(
  tenantId: string,
): Promise<{ products_deactivated: number }> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: check } = await client.query<{ active: boolean }>(
      `SELECT active FROM tenants WHERE id = $1`,
      [tenantId],
    );
    if (!check[0]) {
      await client.query('ROLLBACK');
      throw new AppError(404, 'Tenant not found');
    }
    if (!check[0].active) {
      await client.query('ROLLBACK');
      throw new AppError(400, 'Tenant already inactive');
    }

    await client.query(
      `UPDATE tenants SET active = false, updated_at = NOW() WHERE id = $1`,
      [tenantId],
    );

    const { rowCount } = await client.query(
      `UPDATE products SET active = false, updated_at = NOW()
         WHERE tenant_id = $1 AND active = true`,
      [tenantId],
    );

    await client.query('COMMIT');
    return { products_deactivated: rowCount ?? 0 };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
