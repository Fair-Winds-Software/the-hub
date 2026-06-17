// Authorized by HUB-830 — hook outbound POST handler; AES-256-GCM decryption; HMAC-SHA256 signing; AbortController timeout
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { AppError } from '../errors/AppError.js';
import type { WorkflowHook } from './hookMatchingService.js';

const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

function getEncryptionKey(): Buffer {
  const hex = process.env.HOOK_ENCRYPTION_KEY;
  if (!hex) throw new AppError(500, 'Hook encryption key not configured');
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) throw new AppError(500, 'HOOK_ENCRYPTION_KEY must be a 64-character hex string');
  return key;
}

export function encryptHookSecret(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function decryptHookSecret(ciphertext: string): string {
  const key = getEncryptionKey();
  try {
    const buf = Buffer.from(ciphertext, 'base64');
    const iv = buf.subarray(0, IV_BYTES);
    const authTag = buf.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
    const encrypted = buf.subarray(IV_BYTES + AUTH_TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    throw new AppError(500, 'Hook secret decryption failed');
  }
}

export async function deliverHook(
  hook: WorkflowHook,
  payload: object,
): Promise<{ statusCode: number; durationMs: number }> {
  const url = hook.action_config.url;
  const encryptedSecret = hook.action_config.hmac_secret;

  const decryptedSecret = decryptHookSecret(encryptedSecret);
  const body = JSON.stringify(payload);
  const signature = createHmac('sha256', decryptedSecret).update(body).digest('hex');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-HUB-Hook-Signature': `sha256=${signature}`,
      },
      body,
      signal: controller.signal,
    });
    const durationMs = Date.now() - start;
    if (!res.ok) throw new AppError(502, `Hook delivery failed: ${res.status}`);
    return { statusCode: res.status, durationMs };
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new AppError(504, 'Hook delivery timed out');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
