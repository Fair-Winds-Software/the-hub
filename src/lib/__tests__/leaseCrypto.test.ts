// Authorized by HUB-525 — unit tests: encryptLeaseToken, decryptLeaseToken, signLeasePayload, verifyLeaseSignature
import { describe, it, expect, vi } from 'vitest';

// Set LEASE_ENCRYPTION_KEY before the module is imported — it validates at module load.
vi.hoisted(() => {
  process.env.LEASE_ENCRYPTION_KEY = '00'.repeat(32); // 64-char hex → 32 bytes
});

import {
  encryptLeaseToken,
  decryptLeaseToken,
  signLeasePayload,
  verifyLeaseSignature,
} from '../leaseCrypto.js';
import type { LeasePayload } from '../leaseCrypto.js';

const SAMPLE_PAYLOAD: Omit<LeasePayload, 'sig'> = {
  leaseId: 'test-lease-id',
  tenantId: 'tenant-1',
  productId: 'product-1',
  issuedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-31T00:00:00.000Z',
  renewsAt: '2026-01-31T00:00:00.000Z',
  gateSnapshot: { featureA: true, featureB: false },
  versionStatus: 'supported',
  sdkVersion: '1.0.0',
};

const CLIENT_SECRET = 'super-secret-client-key';

// ── encryptLeaseToken / decryptLeaseToken ─────────────────────────────────────

describe('encryptLeaseToken / decryptLeaseToken', () => {
  it('round-trip returns original plaintext', () => {
    const plaintext = 'Hello, lease world!';
    const ciphertext = encryptLeaseToken(plaintext);
    expect(decryptLeaseToken(ciphertext)).toBe(plaintext);
  });

  it('produces different ciphertext on each call (random IV)', () => {
    const plaintext = 'same input';
    const ct1 = encryptLeaseToken(plaintext);
    const ct2 = encryptLeaseToken(plaintext);
    expect(ct1).not.toBe(ct2);
  });

  it('decryptLeaseToken returns the full signedPayload string round-trip', () => {
    const json = JSON.stringify({ foo: 'bar', num: 42 });
    expect(decryptLeaseToken(encryptLeaseToken(json))).toBe(json);
  });

  it('decryptLeaseToken throws AppError(500) on tampered ciphertext', () => {
    const ciphertext = encryptLeaseToken('test');
    const tampered = ciphertext.slice(0, -4) + 'XXXX';
    expect(() => decryptLeaseToken(tampered)).toThrow();
  });
});

// ── signLeasePayload / verifyLeaseSignature ───────────────────────────────────

describe('signLeasePayload + verifyLeaseSignature', () => {
  it('verifyLeaseSignature returns true for a valid signature', () => {
    const sig = signLeasePayload(SAMPLE_PAYLOAD, CLIENT_SECRET);
    expect(verifyLeaseSignature(SAMPLE_PAYLOAD, sig, CLIENT_SECRET)).toBe(true);
  });

  it('verifyLeaseSignature returns false with a wrong clientSecret', () => {
    const sig = signLeasePayload(SAMPLE_PAYLOAD, CLIENT_SECRET);
    expect(verifyLeaseSignature(SAMPLE_PAYLOAD, sig, 'wrong-secret')).toBe(false);
  });

  it('verifyLeaseSignature returns false when payload is tampered', () => {
    const sig = signLeasePayload(SAMPLE_PAYLOAD, CLIENT_SECRET);
    const tampered = { ...SAMPLE_PAYLOAD, sdkVersion: '9.9.9' };
    expect(verifyLeaseSignature(tampered, sig, CLIENT_SECRET)).toBe(false);
  });

  it('verifyLeaseSignature returns false for an empty sig', () => {
    expect(verifyLeaseSignature(SAMPLE_PAYLOAD, '', CLIENT_SECRET)).toBe(false);
  });

  it('signLeasePayload produces different sigs for different payloads', () => {
    const sig1 = signLeasePayload(SAMPLE_PAYLOAD, CLIENT_SECRET);
    const sig2 = signLeasePayload({ ...SAMPLE_PAYLOAD, tenantId: 'tenant-2' }, CLIENT_SECRET);
    expect(sig1).not.toBe(sig2);
  });
});
