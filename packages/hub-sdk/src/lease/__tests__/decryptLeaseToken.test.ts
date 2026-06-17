// Authorized by HUB-957 — unit tests: decryptLeaseToken; happy path; tampered ciphertext; wrong key; too-short buffer

import { describe, it, expect } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';
import { decryptLeaseToken } from '../decryptLeaseToken.js';
import { HubLeaseInvalidError } from '../../errors.js';
import { TEST_ENC_KEY, makePayload, makeLeaseToken } from './leaseFactory.js';
import { verifyLeaseSignature } from '../verifyLeaseSignature.js';
import { TEST_CLIENT_SECRET } from './leaseFactory.js';

function encryptOnly(payload: object, key = TEST_ENC_KEY): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const plain = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([nonce, ciphertext, authTag]).toString('base64');
}

describe('decryptLeaseToken', () => {
  it('decrypts and returns LeasePayload on valid token', () => {
    const payload = makePayload();
    const encrypted = encryptOnly(payload);
    const result = decryptLeaseToken(encrypted, TEST_ENC_KEY);
    expect(result.tenantId).toBe(payload.tenantId);
    expect(result.productId).toBe(payload.productId);
    expect(result.features).toEqual(payload.features);
    expect(result.maxSeats).toBe(payload.maxSeats);
    expect(result.killSwitch).toBe(payload.killSwitch);
  });

  it('throws HubLeaseInvalidError when buffer is too short', () => {
    const tooShort = Buffer.alloc(28, 0).toString('base64'); // exactly 28 bytes = 12 + 16, empty ciphertext but still edge
    // Actually we need <= 28 to fail — use 10 bytes
    const tinyBuf = Buffer.alloc(10, 0).toString('base64');
    expect(() => decryptLeaseToken(tinyBuf, TEST_ENC_KEY)).toThrowError(HubLeaseInvalidError);
  });

  it('throws HubLeaseInvalidError when ciphertext is tampered (auth tag mismatch)', () => {
    const payload = makePayload();
    const encrypted = encryptOnly(payload);
    const buf = Buffer.from(encrypted, 'base64');
    // Flip a byte in the ciphertext region
    buf[15] ^= 0xff;
    const tampered = buf.toString('base64');
    expect(() => decryptLeaseToken(tampered, TEST_ENC_KEY)).toThrowError(HubLeaseInvalidError);
  });

  it('throws HubLeaseInvalidError when decrypted with wrong key', () => {
    const payload = makePayload();
    const encrypted = encryptOnly(payload);
    const wrongKey = Buffer.alloc(32, 0xcd);
    expect(() => decryptLeaseToken(encrypted, wrongKey)).toThrowError(HubLeaseInvalidError);
  });

  it('preserves killSwitch field value when true', () => {
    const payload = makePayload({ killSwitch: true });
    const encrypted = encryptOnly(payload);
    const result = decryptLeaseToken(encrypted, TEST_ENC_KEY);
    expect(result.killSwitch).toBe(true);
  });

  it('round-trips a token produced by leaseFactory', () => {
    const payload = makePayload();
    const token = makeLeaseToken(payload);
    const encrypted = verifyLeaseSignature(token, TEST_CLIENT_SECRET);
    const result = decryptLeaseToken(encrypted, TEST_ENC_KEY);
    expect(result.tenantId).toBe(payload.tenantId);
    expect(result.productId).toBe(payload.productId);
  });
});
