// Authorized by HUB-1032 — loginOperator; bcrypt verify; JWT with role+tenant_id; refresh token issuance
// Authorized by HUB-1033 — refreshOperatorToken; token rotation in pg transaction; logoutOperator; revoke-on-use
// Authorized by HUB-1704 (CR-6 under HUB-1556) — audit writes (login.success/failure, logout,
//   refresh_token.revoked) per HUB-1580 R1 (D-HUB-SCOPE-028). Audit calls use the never-throws
//   writeAuditEntry contract (HUB-1517) — DB failures are logged but do not break the auth flow.
// Authorized by HUB-1695 (E-BE-1 S18) — revokePendingSession: anonymous idempotent session revoke
//   for the FE logout retry-on-reconnect flow (D-HUB-SCOPE-030). sessionId = operator_refresh_tokens.id
//   (HUB has no separate sessions table — story spec said "sessions"; documented deviation).
//   Race-safe revoke via `UPDATE ... WHERE id=$1 AND revoked=false` returning rowCount; only writes
//   audit when the guarded UPDATE actually flipped state, so parallel duplicate calls produce one
//   audit row, not two.
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';
import { writeAuditEntry } from './auditLogService.js';

const REFRESH_BCRYPT_COST = 10;
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// HUB-1704: HUB-internal events are not scoped to a customer tenant. Use a sentinel UUID
// so the NOT NULL tenant_id constraint is satisfied; no FK on audit_log.tenant_id so no
// seed row is required. The sentinel mnemonic "0...0a1" = "auth internal" (a1 → "auth 1").
const HUB_INTERNAL_TENANT_ID = '00000000-0000-0000-0000-0000000000a1';

interface LoginResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

interface OperatorRow {
  id: string;
  password_hash: string;
  role: 'super_admin' | 'product_admin';
  tenant_id: string | null;
  active: boolean;
}

/**
 * HUB-1704: per-call audit context propagated from the Fastify route handlers
 * (request.ip, request.id). Optional so that internal callers without HTTP context
 * (e.g., scripts, migrations) can still call the service; in those cases the audit
 * row records null ip/trace which is acceptable for non-HTTP origin events.
 */
export interface AuditContext {
  ip?: string | null;
  trace_id?: string | null;
}

export async function loginOperator(
  email: string,
  password: string,
  audit_context: AuditContext = {},
): Promise<LoginResult> {
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
    // Classify the failure for SOC 2 evidence. The auth response is the same opaque
    // 401 regardless — the failure reason is only persisted to audit_log, never returned.
    const reason: 'invalid_credentials' | 'operator_deactivated' =
      row && valid && !row.active ? 'operator_deactivated' : 'invalid_credentials';

    await writeAuditEntry({
      tenant_id: HUB_INTERNAL_TENANT_ID,
      actor_id: row?.id ?? null,
      actor_type: 'operator',
      operation: 'INSERT',
      table_name: 'operator_accounts',
      event_type: 'auth.login.failure',
      new_values: { email, reason },
      ip_address: audit_context.ip ?? null,
      trace_id: audit_context.trace_id ?? null,
    });

    throw new AppError(401, 'Invalid credentials');
  }

  await writeAuditEntry({
    tenant_id: HUB_INTERNAL_TENANT_ID,
    actor_id: row.id,
    actor_type: 'operator',
    operation: 'INSERT',
    table_name: 'operator_accounts',
    record_id: row.id,
    event_type: 'auth.login.success',
    new_values: { email, role: row.role },
    ip_address: audit_context.ip ?? null,
    trace_id: audit_context.trace_id ?? null,
  });

  return issueTokenPair(row.id, row.role, row.tenant_id);
}

async function issueTokenPair(
  operatorId: string,
  role: 'super_admin' | 'product_admin',
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

export async function refreshOperatorToken(
  refreshToken: string,
  audit_context: AuditContext = {},
): Promise<LoginResult> {
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
    role: 'super_admin' | 'product_admin';
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

    // Audit the rotation (the OLD token was revoked; record_id captures it).
    await writeAuditEntry({
      tenant_id: HUB_INTERNAL_TENANT_ID,
      actor_id: op.id,
      actor_type: 'operator',
      operation: 'UPDATE',
      table_name: 'operator_refresh_tokens',
      record_id: tokenId,
      event_type: 'auth.refresh_token.revoked',
      ip_address: audit_context.ip ?? null,
      trace_id: audit_context.trace_id ?? null,
    });

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

export async function logoutOperator(
  refreshToken: string,
  audit_context: AuditContext = {},
): Promise<void> {
  let tokenId: string;
  try {
    ({ tokenId } = parseRefreshToken(refreshToken));
  } catch {
    return; // idempotent — malformed token treated as already logged out, no audit row
  }
  const pool = getPool();

  // Resolve operator_id from the refresh token row BEFORE revoking, so the audit captures
  // who logged out. If the token doesn't exist (already revoked, expired, never issued)
  // we still complete the logout silently — but we skip the audit write since there is
  // no actual session being ended.
  const { rows } = await pool.query<{ operator_id: string }>(
    `SELECT operator_id FROM operator_refresh_tokens WHERE id = $1`,
    [tokenId],
  );
  const operatorId = rows[0]?.operator_id ?? null;

  await pool.query(
    `UPDATE operator_refresh_tokens SET revoked = true WHERE id = $1`,
    [tokenId],
  );

  if (operatorId !== null) {
    await writeAuditEntry({
      tenant_id: HUB_INTERNAL_TENANT_ID,
      actor_id: operatorId,
      actor_type: 'operator',
      operation: 'UPDATE',
      table_name: 'operator_refresh_tokens',
      record_id: tokenId,
      event_type: 'auth.logout',
      ip_address: audit_context.ip ?? null,
      trace_id: audit_context.trace_id ?? null,
    });
  }
}

export type RevokePendingReason = 'not_found' | 'already_revoked' | 'expired';

export interface RevokePendingResult {
  revoked: boolean;
  reason?: RevokePendingReason;
}

/**
 * HUB-1695 (E-BE-1 S18) — anonymous idempotent revoke for the FE logout retry-on-reconnect
 * flow. Caller is unauthenticated by construction (user already clicked logout, local state
 * cleared, refresh-token cookie cleared); the only identifier they retain is the session id
 * stashed in sessionStorage before tear-down. Safety: knowing a sessionId allows revoking
 * that one session — same outcome as the user's intended logout, no privilege escalation.
 * Rate limit (10/min/IP) at the route layer defends against enumeration. Returns:
 *   { revoked: true }                                       — guarded UPDATE flipped state
 *   { revoked: false, reason: 'not_found' }                 — sessionId is unknown
 *   { revoked: false, reason: 'already_revoked' }           — replay-safe
 *   { revoked: false, reason: 'expired' }                   — refresh token TTL elapsed
 */
export async function revokePendingSession(
  sessionId: string,
  audit_context: AuditContext = {},
): Promise<RevokePendingResult> {
  const pool = getPool();

  const { rows } = await pool.query<{
    operator_id: string;
    revoked: boolean;
    expires_at: Date;
  }>(
    `SELECT operator_id, revoked, expires_at
       FROM operator_refresh_tokens
      WHERE id = $1`,
    [sessionId],
  );

  if (rows.length === 0) return { revoked: false, reason: 'not_found' };

  const row = rows[0]!;
  if (row.revoked) return { revoked: false, reason: 'already_revoked' };
  if (row.expires_at.getTime() < Date.now()) return { revoked: false, reason: 'expired' };

  // Guarded UPDATE: only flips state if currently revoked=false. Parallel duplicate calls
  // will only see rowCount=1 once, so we only write one audit row.
  const upd = await pool.query(
    `UPDATE operator_refresh_tokens
        SET revoked = true
      WHERE id = $1 AND revoked = false`,
    [sessionId],
  );

  if (upd.rowCount === 0) {
    // Lost the race — another call already revoked. Treat as already_revoked, no audit.
    return { revoked: false, reason: 'already_revoked' };
  }

  await writeAuditEntry({
    tenant_id: HUB_INTERNAL_TENANT_ID,
    actor_id: 'system:logout-retry',
    actor_type: 'system',
    operation: 'UPDATE',
    table_name: 'operator_refresh_tokens',
    record_id: sessionId,
    event_type: 'auth.session.revoke_pending',
    new_values: {
      trigger: 'pending_revoke_retry',
      operator_id: row.operator_id,
    },
    ip_address: audit_context.ip ?? null,
    trace_id: audit_context.trace_id ?? null,
  });

  return { revoked: true };
}
