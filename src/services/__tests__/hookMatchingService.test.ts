// Authorized by HUB-822 — unit tests: findMatchingHooks(); OR-NULL wildcard combinations; disabled hook exclusion
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPoolQuery = vi.hoisted(() => vi.fn());
vi.mock('../../db/pool.js', () => ({
  getPool: () => ({ query: mockPoolQuery }),
}));

import { findMatchingHooks } from '../hookMatchingService.js';

const TENANT_ID  = 'aaaaaaaa-0000-0000-0000-000000000001';
const PRODUCT_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const HOOK_ID    = 'cccccccc-0000-0000-0000-000000000003';

const BASE_HOOK = {
  id: HOOK_ID,
  tenant_id: TENANT_ID,
  product_id: PRODUCT_ID,
  trigger_event_type: 'alert.fired',
  action_type: 'webhook',
  action_config: { url: 'https://hooks.example.com', hmac_secret: 'enc' },
  enabled: true,
  created_at: new Date().toISOString(),
};

beforeEach(() => { vi.resetAllMocks(); });

describe('findMatchingHooks', () => {
  it('returns matching hooks for exact tenant and product', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [BASE_HOOK] });
    const result = await findMatchingHooks('alert.fired', TENANT_ID, PRODUCT_ID);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(HOOK_ID);
    const sql = mockPoolQuery.mock.calls[0]![0] as string;
    expect(sql).toContain('tenant_id IS NULL OR tenant_id =');
    expect(sql).toContain('product_id IS NULL OR product_id =');
    expect(sql).toContain('enabled = true');
  });

  it('returns empty array when no hooks match', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await findMatchingHooks('alert.fired', TENANT_ID, PRODUCT_ID);
    expect(result).toEqual([]);
  });

  it('passes eventType, tenantId, productId as positional params', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await findMatchingHooks('alert.fired', TENANT_ID, PRODUCT_ID);
    const params = mockPoolQuery.mock.calls[0]![1] as unknown[];
    expect(params[0]).toBe('alert.fired');
    expect(params[1]).toBe(TENANT_ID);
    expect(params[2]).toBe(PRODUCT_ID);
  });

  it('returns multiple matching hooks ordered by created_at', async () => {
    const hook2 = { ...BASE_HOOK, id: 'hook-2' };
    mockPoolQuery.mockResolvedValueOnce({ rows: [BASE_HOOK, hook2] });
    const result = await findMatchingHooks('alert.fired', TENANT_ID, PRODUCT_ID);
    expect(result).toHaveLength(2);
  });

  it('uses ORDER BY created_at ASC in query', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await findMatchingHooks('alert.fired', TENANT_ID, PRODUCT_ID);
    const sql = mockPoolQuery.mock.calls[0]![0] as string;
    expect(sql).toContain('ORDER BY created_at ASC');
  });
});
