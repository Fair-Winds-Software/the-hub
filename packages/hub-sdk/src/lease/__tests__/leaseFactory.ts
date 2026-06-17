// Authorized by HUB-957 — test factory for generating valid signed + encrypted LeasePayload fixtures

import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import type { LeasePayload } from '../types.js';

export const TEST_ENC_KEY = Buffer.alloc(32, 0xab);
export const TEST_CLIENT_SECRET = 'test-client-secret';

export function makePayload(overrides?: Partial<LeasePayload>): LeasePayload {
  return {
    tenantId: 'tenant-123',
    productId: 'product-abc',
    features: ['feature-1', 'feature-2'],
    maxSeats: 10,
    expiresAt: Date.now() + 86_400_000,
    killSwitch: false,
    ...overrides,
  };
}

export function makeLeaseToken(
  payload: LeasePayload,
  opts?: { encKey?: Buffer; clientSecret?: string },
): string {
  const key = opts?.encKey ?? TEST_ENC_KEY;
  const secret = opts?.clientSecret ?? TEST_CLIENT_SECRET;

  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const plain = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const encrypted = Buffer.concat([nonce, ciphertext, authTag]).toString('base64');

  const sig = createHmac('sha256', secret).update(encrypted).digest('hex');
  return `${encrypted}.${sig}`;
}
