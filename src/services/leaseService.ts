// Authorized by HUB-370 — issueLease() atomic chain; HMAC signing; AES-256-GCM encryption
// Authorized by HUB-371 — verifyLease() stateless HMAC + revocation check
// Authorized by HUB-372 — extendLease() + revokeLease() operator services
// Authorized by HUB-538 — issueLease, verifyLease, revokeLease; composed atomic chain
// Authorized by HUB-539 — extendLease operator action with 5-day increment validation
import { randomUUID } from 'node:crypto';
import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';
import logger from '../lib/logger.js';
import { encryptLeaseToken, signLeasePayload, verifyLeaseSignature } from '../lib/leaseCrypto.js';
import type { LeasePayload } from '../lib/leaseCrypto.js';
import { getLicenseStatus } from './license.js';
import { getAllGateSnapshot } from './featureGate.js';
import { checkVersionCompatibility, recordSdkVersion } from './versionReporting.js';
import { TODO_D_LEASE_RENEWAL_DAYS } from '../config/decisions.js';

export interface LeaseRow {
  id: string;
  tenant_id: string;
  product_id: string;
  issued_at: Date;
  expires_at: Date;
  renews_at: Date;
  revoked_at: Date | null;
  revoke_reason: string | null;
  sdk_version_at_issue: string;
  gate_snapshot: Record<string, boolean>;
  delta_data: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export interface IssuedLease {
  signedPayload: string;
  expiresAt: Date;
  renewsAt: Date;
}

// ── computeRenewsAt ───────────────────────────────────────────────────────────

// TODO-D-DEF-LEASE-RENEWAL: computation deferred. Using expiresAt as placeholder until decision resolves.
// When TODO_D_LEASE_RENEWAL_DAYS is set, renewsAt = expiresAt − daysBeforeExpiry.
function computeRenewsAt(expiresAt: Date): Date {
  if (TODO_D_LEASE_RENEWAL_DAYS !== null) {
    return new Date(expiresAt.getTime() - TODO_D_LEASE_RENEWAL_DAYS * 24 * 60 * 60 * 1000);
  }
  return new Date(expiresAt.getTime()); // placeholder: same as expiresAt
}

// ── issueLease ────────────────────────────────────────────────────────────────

export async function issueLease(
  tenantId: string,
  productId: string,
  sdkVersion: string,
  clientSecret: string,
): Promise<IssuedLease> {
  // Step 1: License gate — 403 if suspended or cancelled
  const licenseStatus = await getLicenseStatus(tenantId, productId);
  if (licenseStatus.status === 'suspended' || licenseStatus.status === 'cancelled') {
    throw new AppError(403, 'License not active');
  }

  // Step 2: Gate snapshot — full map embedded in lease
  const gateSnapshot = await getAllGateSnapshot(tenantId, productId);

  // Step 3: Version compatibility — 403 sunset, 404 unknown
  const versionStatus = await checkVersionCompatibility(productId, sdkVersion);

  // Steps 4–5: Pure crypto — no DB calls
  const leaseId = randomUUID();
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + 30 * 24 * 60 * 60 * 1000); // D-003: 30 days
  const renewsAt = computeRenewsAt(expiresAt);

  const payloadWithoutSig: Omit<LeasePayload, 'sig'> = {
    leaseId,
    tenantId,
    productId,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    renewsAt: renewsAt.toISOString(),
    gateSnapshot,
    versionStatus: versionStatus.status,
    sdkVersion,
  };

  const sig = signLeasePayload(payloadWithoutSig, clientSecret);
  const signedPayload = JSON.stringify({ ...payloadWithoutSig, sig });

  // Encrypt signedPayload at rest — lease_token NEVER returned to callers
  const leaseToken = encryptLeaseToken(signedPayload);

  // Step 6: INSERT in explicit transaction — rollback on any failure
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO leases
         (id, tenant_id, product_id, lease_token, signed_payload,
          issued_at, expires_at, renews_at, sdk_version_at_issue, gate_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        leaseId,
        tenantId,
        productId,
        leaseToken,
        signedPayload,
        issuedAt,
        expiresAt,
        renewsAt,
        sdkVersion,
        JSON.stringify(gateSnapshot),
      ],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Post-commit: record SDK version (fire-and-forget; failure does not affect lease)
  try {
    await recordSdkVersion(tenantId, productId, sdkVersion);
  } catch (err) {
    logger.warn({ err, tenantId, productId, sdkVersion }, 'recordSdkVersion failed post-lease-issue');
  }

  return { signedPayload, expiresAt, renewsAt };
}

// ── verifyLease ───────────────────────────────────────────────────────────────

export async function verifyLease(
  signedPayloadStr: string,
  clientSecret: string,
): Promise<{ valid: boolean; reason?: string; payload?: Omit<LeasePayload, 'sig'> }> {
  // Phase 1: Stateless HMAC verification — no DB read on failure
  let parsed: LeasePayload;
  try {
    parsed = JSON.parse(signedPayloadStr) as LeasePayload;
  } catch {
    return { valid: false, reason: 'invalid_signature' };
  }

  const { sig, ...payloadWithoutSig } = parsed;
  const hmacValid = verifyLeaseSignature(payloadWithoutSig, sig, clientSecret);
  if (!hmacValid) {
    return { valid: false, reason: 'invalid_signature' };
  }

  // Phase 2: DB revocation + expiry check (one indexed PK lookup)
  const pool = getPool();
  const { rows } = await pool.query<{ revoked_at: Date | null; expires_at: Date }>(
    'SELECT revoked_at, expires_at FROM leases WHERE id = $1',
    [parsed.leaseId],
  );

  if (!rows[0]) {
    return { valid: false, reason: 'invalid_signature' };
  }

  const { revoked_at, expires_at } = rows[0];

  // Revocation takes priority over expiry (explicit operator action)
  if (revoked_at) {
    return { valid: false, reason: 'revoked' };
  }
  if (new Date(expires_at) < new Date()) {
    return { valid: false, reason: 'expired' };
  }

  return { valid: true, payload: payloadWithoutSig };
}

// ── revokeLease ───────────────────────────────────────────────────────────────

export async function revokeLease(leaseId: string, reason: string): Promise<LeaseRow> {
  const pool = getPool();
  const { rows } = await pool.query<LeaseRow>(
    `UPDATE leases
     SET revoked_at = NOW(), revoke_reason = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [leaseId, reason],
  );
  if (!rows[0]) {
    throw new AppError(404, 'Lease not found');
  }
  return rows[0];
}

// ── extendLease ───────────────────────────────────────────────────────────────

export async function extendLease(
  leaseId: string,
  daysToExtend: number,
  operatorId: string,
): Promise<{ leaseId: string; expiresAt: Date; renewsAt: Date }> {
  if (daysToExtend <= 0 || daysToExtend % 5 !== 0) {
    throw new AppError(400, 'daysToExtend must be a positive multiple of 5');
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query<{ expires_at: Date; revoked_at: Date | null; renews_at: Date }>(
      'SELECT expires_at, revoked_at, renews_at FROM leases WHERE id = $1 FOR UPDATE',
      [leaseId],
    );
    if (!rows[0]) throw new AppError(404, 'Lease not found');

    const lease = rows[0];
    if (lease.revoked_at) throw new AppError(409, 'Lease is revoked and cannot be extended');
    if (new Date(lease.expires_at) < new Date()) throw new AppError(409, 'Cannot extend expired lease');

    const newExpiresAt = new Date(
      new Date(lease.expires_at).getTime() + daysToExtend * 24 * 60 * 60 * 1000,
    );
    const newRenewsAt = computeRenewsAt(newExpiresAt);

    const { rows: updated } = await client.query<{ id: string; expires_at: Date; renews_at: Date }>(
      `UPDATE leases
       SET expires_at = $2, renews_at = $3, updated_at = NOW()
       WHERE id = $1
       RETURNING id, expires_at, renews_at`,
      [leaseId, newExpiresAt, newRenewsAt],
    );

    await client.query('COMMIT');

    logger.info({ leaseId, daysToExtend, operatorId }, 'Lease extended');
    return { leaseId: updated[0]!.id, expiresAt: updated[0]!.expires_at, renewsAt: updated[0]!.renews_at };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
