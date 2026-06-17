// Authorized by HUB-1032 — loginOperator; bcrypt verify; JWT with role+tenant_id; refresh token issuance
// Authorized by HUB-1033 — refreshOperatorToken; token rotation in pg transaction; logoutOperator; revoke-on-use
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';

const REFRESH_BCRYPT_COST = 10;
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface LoginResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

interface OperatorRow {
  id: string;
  password_hash: string;
  role: 'super_admin' | 'tenant_admin';
  tenant_id: string | null;
  active: boolean;
}

export async function loginOperator(email: string, password: string): Promise<LoginResult> {
  const pool = getPool();
  const DUMMY_HASH = await bcrypt.hash('__hub_admin_dummy__', 12);

  const { rows } = await pool.query<OperatorRow>(
    `SELECT id, password_hash, role, tenant_id, active
       FROM operator_accounts WHERE email = $1`,
    [email],
  );

  const row = rows[0];
  const valid = await bcrypt.compare(password, row?.password_hash ?? DUMMY_HASH);

  if (!row || !valid || !row.active) {
    throw new AppError(401, 'Invalid credentials');
  }

  return issueTokenPair(row.id, row.role, row.tenant_id);
}

async function issueTokenPair(
  operatorId: string,
  role: 'super_admin' | 'tenant_admin',
  tenantId: string | null,
): Promise<LoginResult> {
  const pool = getPool();
  const secret = process.env.OPERATOR_JWT_SECRET!;
  const ttl = parseInt(process.env.OPERATOR_JWT_TTL_SECONDS ?? '900', 10);

  const accessToken = jwt.sign(
    { operator_id: operatorId, role, tenant_id: tenantId },
    secret,
    { expiresIn: ttl },
  );

  const rawHex = crypto.randomBytes(32).toString('hex');
  const tokenHash = await bcrypt.hash(rawHex, REFRESH_BCRYPT_COST);
  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO operator_refresh_tokens (operator_id, token_hash, expires_at)
     VALUES ($1, $2, $3) RETURNING id`,
    [operatorId, tokenHash, expiresAt],
  );

  const tokenId = rows[0]!.id;
  return { accessToken, refreshToken: `${tokenId}.${rawHex}`, expiresIn: ttl };
}

function parseRefreshToken(refreshToken: string): { tokenId: string; rawHex: string } {
  const dot = refreshToken.indexOf('.');
  if (dot < 1) throw new AppError(401, 'Invalid refresh token');
  return { tokenId: refreshToken.slice(0, dot), rawHex: refreshToken.slice(dot + 1) };
}

export async function refreshOperatorToken(refreshToken: string): Promise<LoginResult> {
  const pool = getPool();
  const { tokenId, rawHex } = parseRefreshToken(refreshToken);

  const { rows } = await pool.query<{ id: string; operator_id: string; token_hash: string }>(
    `SELECT id, operator_id, token_hash FROM operator_refresh_tokens
     WHERE id = $1 AND revoked = false AND expires_at > NOW()`,
    [tokenId],
  );

  const tokenRow = rows[0];
  if (!tokenRow) throw new AppError(401, 'Invalid refresh token');

  const valid = await bcrypt.compare(rawHex, tokenRow.token_hash);
  if (!valid) throw new AppError(401, 'Invalid refresh token');

  // Reload current claims — role may have changed since original login
  const { rows: opRows } = await pool.query<{
    id: string;
    role: 'super_admin' | 'tenant_admin';
    tenant_id: string | null;
  }>(
    `SELECT id, role, tenant_id FROM operator_accounts WHERE id = $1 AND active = true`,
    [tokenRow.operator_id],
  );
  const op = opRows[0];
  if (!op) throw new AppError(401, 'Invalid refresh token');

  // Token rotation: revoke old + insert new atomically
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE operator_refresh_tokens SET revoked = true WHERE id = $1`,
      [tokenId],
    );
    const rawNew = crypto.randomBytes(32).toString('hex');
    const newHash = await bcrypt.hash(rawNew, REFRESH_BCRYPT_COST);
    const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
    const { rows: newRows } = await client.query<{ id: string }>(
      `INSERT INTO operator_refresh_tokens (operator_id, token_hash, expires_at)
       VALUES ($1, $2, $3) RETURNING id`,
      [op.id, newHash, expiresAt],
    );
    await client.query('COMMIT');

    const secret = process.env.OPERATOR_JWT_SECRET!;
    const ttl = parseInt(process.env.OPERATOR_JWT_TTL_SECONDS ?? '900', 10);
    const accessToken = jwt.sign(
      { operator_id: op.id, role: op.role, tenant_id: op.tenant_id },
      secret,
      { expiresIn: ttl },
    );
    const newTokenId = newRows[0]!.id;
    return { accessToken, refreshToken: `${newTokenId}.${rawNew}`, expiresIn: ttl };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function logoutOperator(refreshToken: string): Promise<void> {
  let tokenId: string;
  try {
    ({ tokenId } = parseRefreshToken(refreshToken));
  } catch {
    return; // idempotent — malformed token treated as already logged out
  }
  const pool = getPool();
  await pool.query(
    `UPDATE operator_refresh_tokens SET revoked = true WHERE id = $1`,
    [tokenId],
  );
}
