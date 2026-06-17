// Authorized by HUB-923 — AES-256-GCM decryption of lease tokens; layout: nonce(12)|ciphertext|authTag(16), base64

import { createDecipheriv } from 'node:crypto';
import { HubLeaseInvalidError } from '../errors.js';
import type { LeasePayload } from './types.js';

const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MIN_BYTES = NONCE_BYTES + AUTH_TAG_BYTES;

export function decryptLeaseToken(encryptedBase64: string, key: Buffer): LeasePayload {
  const buf = Buffer.from(encryptedBase64, 'base64');
  if (buf.length <= MIN_BYTES) {
    throw new HubLeaseInvalidError('Lease token too short to contain nonce and auth tag');
  }

  const nonce = buf.subarray(0, NONCE_BYTES);
  const authTag = buf.subarray(buf.length - AUTH_TAG_BYTES);
  const ciphertext = buf.subarray(NONCE_BYTES, buf.length - AUTH_TAG_BYTES);

  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(authTag);

  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8')) as LeasePayload;
  } catch {
    throw new HubLeaseInvalidError('Lease token decryption failed: invalid key or tampered data');
  }
}
