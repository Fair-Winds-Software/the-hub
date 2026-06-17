// Authorized by HUB-1058 — createOperator; listOperators; getOperator; updateOperator; deactivateOperator
// Authorized by HUB-1059 — assignOperatorRole; tenant existence check; self-change guard
import bcrypt from 'bcryptjs';
import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OperatorRecord {
  id: string;
  email: string;
  role: 'super_admin' | 'tenant_admin';
  tenant_id: string | null;
  active: boolean;
  created_at: string;
}

const SELECT_COLS = 'id, email, role, tenant_id, active, created_at';

export async function createOperator(data: {
  email: string;
  password: string;
  role: 'super_admin' | 'tenant_admin';
  tenant_id?: string | null;
}): Promise<OperatorRecord> {
  if (!data.email || !EMAIL_RE.test(data.email)) throw new AppError(400, 'Invalid email format');
  if (!data.password) throw new AppError(400, 'password is required');
  if (!['super_admin', 'tenant_admin'].includes(data.role)) throw new AppError(400, 'Invalid role');
  if (data.role === 'tenant_admin') {
    if (!data.tenant_id || !UUID_RE.test(data.tenant_id)) {
      throw new AppError(400, 'tenant_id is required for tenant_admin and must be a UUID');
    }
  }

  const pool = getPool();
  const rounds = parseInt(process.env.BCRYPT_ROUNDS ?? '12', 10);
  const passwordHash = await bcrypt.hash(data.password, rounds);

  try {
    const { rows } = await pool.query<OperatorRecord>(
      `INSERT INTO operator_accounts (email, password_hash, role, tenant_id)
       VALUES ($1, $2, $3, $4)
       RETURNING ${SELECT_COLS}`,
      [data.email, passwordHash, data.role, data.tenant_id ?? null],
    );
    return rows[0]!;
  } catch (err: unknown) {
    if ((err as { code?: string }).code === '23505') throw new AppError(409, 'Email already in use');
    throw err;
  }
}

export async function listOperators(active?: boolean): Promise<OperatorRecord[]> {
  const pool = getPool();
  if (active !== undefined) {
    const { rows } = await pool.query<OperatorRecord>(
      `SELECT ${SELECT_COLS} FROM operator_accounts WHERE active = $1 ORDER BY created_at`,
      [active],
    );
    return rows;
  }
  const { rows } = await pool.query<OperatorRecord>(
    `SELECT ${SELECT_COLS} FROM operator_accounts ORDER BY created_at`,
  );
  return rows;
}

export async function getOperator(id: string): Promise<OperatorRecord> {
  const pool = getPool();
  const { rows } = await pool.query<OperatorRecord>(
    `SELECT ${SELECT_COLS} FROM operator_accounts WHERE id = $1`,
    [id],
  );
  if (!rows[0]) throw new AppError(404, 'Operator not found');
  return rows[0];
}

export async function updateOperator(
  id: string,
  data: { email?: string; active?: boolean },
): Promise<OperatorRecord> {
  if (data.email !== undefined && !EMAIL_RE.test(data.email)) throw new AppError(400, 'Invalid email format');
  const pool = getPool();
  try {
    const { rows } = await pool.query<OperatorRecord>(
      `UPDATE operator_accounts
         SET email  = COALESCE($2, email),
             active = COALESCE($3, active)
       WHERE id = $1
       RETURNING ${SELECT_COLS}`,
      [id, data.email ?? null, data.active ?? null],
    );
    if (!rows[0]) throw new AppError(404, 'Operator not found');
    return rows[0];
  } catch (err: unknown) {
    if ((err as { code?: string }).code === '23505') throw new AppError(409, 'Email already in use');
    throw err;
  }
}

export async function deactivateOperator(id: string, requestingOperatorId: string): Promise<void> {
  if (id === requestingOperatorId) throw new AppError(400, 'Cannot deactivate your own account');
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE operator_accounts SET active = false WHERE id = $1`,
    [id],
  );
  if ((rowCount ?? 0) === 0) throw new AppError(404, 'Operator not found');
}

export async function assignOperatorRole(
  operatorId: string,
  role: 'super_admin' | 'tenant_admin',
  tenantId: string | null | undefined,
  requestingOperatorId: string,
): Promise<OperatorRecord> {
  if (operatorId === requestingOperatorId) throw new AppError(400, 'Cannot change your own role');
  if (!['super_admin', 'tenant_admin'].includes(role)) throw new AppError(400, 'Invalid role');

  const pool = getPool();
  let resolvedTenantId: string | null = null;

  if (role === 'tenant_admin') {
    if (!tenantId || !UUID_RE.test(tenantId)) {
      throw new AppError(400, 'tenant_id is required for tenant_admin and must be a UUID');
    }
    const { rows } = await pool.query(`SELECT id FROM tenants WHERE id = $1`, [tenantId]);
    if (!rows[0]) throw new AppError(400, 'Tenant not found');
    resolvedTenantId = tenantId;
  }

  const { rows } = await pool.query<OperatorRecord>(
    `UPDATE operator_accounts SET role = $2, tenant_id = $3
     WHERE id = $1
     RETURNING ${SELECT_COLS}`,
    [operatorId, role, resolvedTenantId],
  );
  if (!rows[0]) throw new AppError(404, 'Operator not found');
  return rows[0];
}
