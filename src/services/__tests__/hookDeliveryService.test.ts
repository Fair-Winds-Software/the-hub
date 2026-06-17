// Authorized by HUB-830 — unit tests: deliverHook(); HMAC-SHA256 signature; AES-256-GCM decrypt; 502/504 errors
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFetch = vi.hoisted(() => vi.fn());
vi.stubGlobal('fetch', mockFetch);

import { encryptHookSecret, deliverHook } from '../hookDeliveryService.js';
import type { WorkflowHook } from '../hookMatchingService.js';

const VALID_KEY_HEX = 'a'.repeat(64); // 32-byte key as 64 hex chars

function makeHook(overrides?: Partial<WorkflowHook['action_config']>): WorkflowHook {
  const secret = encryptHookSecret('my-secret');
  return {
    id: 'hook-1',
    tenant_id: 'tenant-1',
    product_id: null,
    trigger_event_type: 'alert.fired',
    action_type: 'webhook',
    action_config: { url: 'https://hooks.example.com/deliver', hmac_secret: secret, ...overrides },
    enabled: true,
    created_at: new Date().toISOString(),
  };
}

beforeEach(() => {
  process.env.HOOK_ENCRYPTION_KEY = VALID_KEY_HEX;
  mockFetch.mockResolvedValue({ ok: true, status: 200 });
});

afterEach(() => {
  delete process.env.HOOK_ENCRYPTION_KEY;
  vi.resetAllMocks();
});

describe('encryptHookSecret / deliverHook', () => {
  it('throws 500 when HOOK_ENCRYPTION_KEY is not set', async () => {
    delete process.env.HOOK_ENCRYPTION_KEY;
    // Build hook manually — cannot call makeHook() (which encrypts) without the key
    const hook: WorkflowHook = {
      id: 'hook-1', tenant_id: 'tenant-1', product_id: null,
      trigger_event_type: 'alert.fired', action_type: 'webhook',
      action_config: { url: 'https://hooks.example.com', hmac_secret: 'any' },
      enabled: true, created_at: new Date().toISOString(),
    };
    await expect(deliverHook(hook, {})).rejects.toThrow('Hook encryption key not configured');
  });

  it('POSTs to hook URL with JSON body', async () => {
    await deliverHook(makeHook(), { event: 'test' });
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://hooks.example.com/deliver');
    expect(opts.method).toBe('POST');
    expect(opts.headers).toMatchObject({ 'Content-Type': 'application/json' });
  });

  it('includes X-HUB-Hook-Signature header with sha256= prefix', async () => {
    await deliverHook(makeHook(), { event: 'test' });
    const [, opts] = mockFetch.mock.calls[0]! as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers['X-HUB-Hook-Signature']).toMatch(/^sha256=[a-f0-9]+$/);
  });

  it('returns statusCode and durationMs on success', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });
    const result = await deliverHook(makeHook(), {});
    expect(result.statusCode).toBe(200);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('throws AppError(502) on non-2xx response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    await expect(deliverHook(makeHook(), {})).rejects.toThrow('Hook delivery failed');
  });

  it('throws AppError(500) when hmac_secret is corrupted (decrypt fails)', async () => {
    const hook = makeHook({ hmac_secret: 'not-valid-base64-aes-gcm' });
    await expect(deliverHook(hook, {})).rejects.toThrow('Hook secret decryption failed');
  });

  it('encryptHookSecret produces a value that decrypts correctly for signing', async () => {
    const encrypted = encryptHookSecret('round-trip-secret');
    const hook = makeHook({ hmac_secret: encrypted });
    // If decryption fails, deliverHook throws — so success means round-trip worked
    await deliverHook(hook, {});
    expect(mockFetch).toHaveBeenCalledOnce();
  });
});
