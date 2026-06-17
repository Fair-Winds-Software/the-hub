// Authorized by HUB-922 — HMAC-SHA256 signature verification for lease tokens using timingSafeEqual

import { createHmac, timingSafeEqual } from 'node:crypto';
import { HubLeaseInvalidError } from '../errors.js';

export function verifyLeaseSignature(rawToken: string, clientSecret: string): string {
  const lastDot = rawToken.lastIndexOf('.');
  if (lastDot === -1) {
    throw new HubLeaseInvalidError('Malformed lease token: missing signature separator');
  }

  const encrypted = rawToken.slice(0, lastDot);
  const signature = rawToken.slice(lastDot + 1);

  const expectedHex = createHmac('sha256', clientSecret).update(encrypted).digest('hex');
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  const actualBuf = Buffer.from(signature, 'hex');

  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
    throw new HubLeaseInvalidError('Lease token signature verification failed');
  }

  return encrypted;
}
