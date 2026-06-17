// Authorized by HUB-957 — unit tests: verifyLeaseSignature; happy path; wrong sig; malformed token; sig length mismatch

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyLeaseSignature } from '../verifyLeaseSignature.js';
import { HubLeaseInvalidError } from '../../errors.js';
import { TEST_CLIENT_SECRET } from './leaseFactory.js';

function makeToken(encrypted: string, secret = TEST_CLIENT_SECRET): string {
  const sig = createHmac('sha256', secret).update(encrypted).digest('hex');
  return `${encrypted}.${sig}`;
}

describe('verifyLeaseSignature', () => {
  it('returns the encrypted payload when signature is valid', () => {
    const encrypted = 'dGVzdC1wYXlsb2Fk'; // arbitrary base64
    const token = makeToken(encrypted);
    expect(verifyLeaseSignature(token, TEST_CLIENT_SECRET)).toBe(encrypted);
  });

  it('throws HubLeaseInvalidError when signature is wrong', () => {
    const encrypted = 'dGVzdC1wYXlsb2Fk';
    const token = `${encrypted}.badhexbadhex00000000000000000000000000000000000000000000000000000000`;
    expect(() => verifyLeaseSignature(token, TEST_CLIENT_SECRET)).toThrowError(HubLeaseInvalidError);
  });

  it('throws HubLeaseInvalidError when token has no separator', () => {
    expect(() => verifyLeaseSignature('nodothere', TEST_CLIENT_SECRET)).toThrowError(
      HubLeaseInvalidError,
    );
  });

  it('throws HubLeaseInvalidError when signature length does not match expected HMAC-SHA256 length', () => {
    const token = 'payload.tooshort';
    expect(() => verifyLeaseSignature(token, TEST_CLIENT_SECRET)).toThrowError(HubLeaseInvalidError);
  });

  it('handles a token where the encrypted part contains dots (uses lastIndexOf)', () => {
    const encryptedWithDots = 'a.b.c.d';
    const token = makeToken(encryptedWithDots);
    expect(verifyLeaseSignature(token, TEST_CLIENT_SECRET)).toBe(encryptedWithDots);
  });

  it('throws HubLeaseInvalidError when signed with a different secret', () => {
    const encrypted = 'dGVzdC1wYXlsb2Fk';
    const token = makeToken(encrypted, 'wrong-secret');
    expect(() => verifyLeaseSignature(token, TEST_CLIENT_SECRET)).toThrowError(HubLeaseInvalidError);
  });
});
