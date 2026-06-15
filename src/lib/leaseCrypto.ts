// Authorized by HUB-525 — AES-256-GCM lease_token encryption and HMAC-SHA256 payload signing
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { AppError } from '../errors/AppError.js';

export interface LeasePayload {
  leaseId: string;
  tenantId: string;
  productId: string;
  issuedAt: string;
  expiresAt: string;
  renewsAt: string;
  gateSnapshot: Record<string, boolean>;
  versionStatus: string;
  sdkVersion: string;
  sig: string;
}

// Parse and validate LEASE_ENCRYPTION_KEY at module load.
// Throws at startup if missing or wrong length — never at call time.
const _keyHex = process.env.LEASE_ENCRYPTION_KEY ?? '';
const _keyBuf = Buffer.from(_keyHex, 'hex');
if (_keyBuf.length !== 32) {
  throw new Error(
    'LEASE_ENCRYPTION_KEY must be a 64-character hex string encoding a 32-byte AES-256 key',
  );
}
const ENCRYPTION_KEY: Buffer = _keyBuf;

const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

// Encrypts plaintext using AES-256-GCM.
// Returns base64(iv || authTag || ciphertext).
export function encryptLeaseToken(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

// Decrypts a value produced by encryptLeaseToken.
// Throws AppError(500) on any crypto error to avoid leaking internals.
export function decryptLeaseToken(ciphertext: string): string {
  try {
    const buf = Buffer.from(ciphertext, 'base64');
    const iv = buf.subarray(0, IV_BYTES);
    const authTag = buf.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
    const encrypted = buf.subarray(IV_BYTES + AUTH_TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    throw new AppError(500, 'lease decryption failed');
  }
}

// Signs the payload (excluding the sig field) with HMAC-SHA256 using the raw clientSecret.
// Returns a hex digest.
export function signLeasePayload(
  payload: Omit<LeasePayload, 'sig'>,
  clientSecret: string,
): string {
  return createHmac('sha256', clientSecret)
    .update(JSON.stringify(payload))
    .digest('hex');
}

// Verifies that sig matches HMAC-SHA256 over the payload (excluding sig) using clientSecret.
// Uses timingSafeEqual to prevent timing-based attacks.
export function verifyLeaseSignature(
  payload: Omit<LeasePayload, 'sig'>,
  sig: string,
  clientSecret: string,
): boolean {
  try {
    const expected = createHmac('sha256', clientSecret)
      .update(JSON.stringify(payload))
      .digest('hex');
    const sigBuf = Buffer.from(sig, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length === 0 || sigBuf.length !== expBuf.length) return false;
    return timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}
