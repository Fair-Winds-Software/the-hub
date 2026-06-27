// Authorized by HUB-1591 (E-BE-1 S8, CR-2) — unit tests for updatePlanBillingMode covering
// the R1 4-cell transition matrix (S→S, C→C no-ops; S→C, C→S full flip) plus 404 and 400
// validation paths. Mocks pool + writeAuditEntry + clearCreditModeCacheEntry to verify the
// service-boundary behavior in isolation.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPoolQuery = vi.hoisted(() => vi.fn());
vi.mock('../../db/pool.js', () => ({ getPool: () => ({ query: mockPoolQuery }) }));

const mockClearCreditModeCacheEntry = vi.hoisted(() => vi.fn());
vi.mock('../stripeService.js', () => ({
  clearCreditModeCacheEntry: mockClearCreditModeCacheEntry,
}));

const mockWriteAuditEntry = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../auditLogService.js', () => ({ writeAuditEntry: mockWriteAuditEntry }));

vi.mock('../../stripe/client.js', () => ({
  getStripe: vi.fn(),
  stripeIdempotencyKey: vi.fn(),
  mapStripeError: vi.fn(),
}));

import { updatePlanBillingMode, type BillingMode } from '../planCatalogService.js';

const PLAN_ID = '00000000-0000-0000-0000-000000000aaa';
const PRODUCT_ID = '00000000-0000-0000-0000-000000000bbb';
const ACTOR_ID = 'operator-1';

function existingRow(billing_mode: BillingMode) {
  return {
    id: PLAN_ID,
    product_id: PRODUCT_ID,
    key: 'plan-key',
    name: 'Plan Name',
    description: null,
    billing_type: 'flat_rate' as const,
    billing_interval: 'month' as const,
    unit_amount_cents: 1000,
    tiers: null,
    stripe_product_id: 'prod_x',
    stripe_price_id: 'price_x',
    entitlements: {},
    active: true,
    metadata: null,
    delta_data: null,
    created_at: new Date(),
    updated_at: new Date(),
    billing_mode,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('updatePlanBillingMode (HUB-1591)', () => {
  describe('R1 transition matrix', () => {
    it('S → S no-op: returns existing row; no UPDATE, no audit, no cache evict', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [existingRow('standard')] });

      const row = await updatePlanBillingMode(PLAN_ID, 'standard', ACTOR_ID);

      expect(row.id).toBe(PLAN_ID);
      expect(mockPoolQuery).toHaveBeenCalledTimes(1); // only the SELECT
      expect(mockWriteAuditEntry).not.toHaveBeenCalled();
      expect(mockClearCreditModeCacheEntry).not.toHaveBeenCalled();
    });

    it('C → C no-op: returns existing row; no UPDATE, no audit, no cache evict', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [existingRow('credit')] });

      const row = await updatePlanBillingMode(PLAN_ID, 'credit', ACTOR_ID);

      expect(row.id).toBe(PLAN_ID);
      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
      expect(mockWriteAuditEntry).not.toHaveBeenCalled();
      expect(mockClearCreditModeCacheEntry).not.toHaveBeenCalled();
    });

    it('S → C: UPDATE persists; audit row written; cache evicted for planId', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [existingRow('standard')] })
        .mockResolvedValueOnce({ rows: [existingRow('credit')] }); // UPDATE RETURNING

      await updatePlanBillingMode(PLAN_ID, 'credit', ACTOR_ID);

      expect(mockPoolQuery).toHaveBeenCalledTimes(2);
      const [updateSql, updateParams] = mockPoolQuery.mock.calls[1]!;
      expect(updateSql).toMatch(/UPDATE plans SET billing_mode/);
      expect(updateParams[0]).toBe(PLAN_ID);
      expect(updateParams[1]).toBe('credit');

      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      const auditEntry = mockWriteAuditEntry.mock.calls[0]![0];
      expect(auditEntry).toMatchObject({
        actor_id: ACTOR_ID,
        actor_type: 'operator',
        operation: 'UPDATE',
        table_name: 'plans',
        record_id: PLAN_ID,
        old_values: { billing_mode: 'standard' },
      });
      expect(auditEntry.new_values).toMatchObject({
        billing_mode: 'credit',
        event: 'plan.billing_mode.changed',
        from: 'standard',
        to: 'credit',
      });

      expect(mockClearCreditModeCacheEntry).toHaveBeenCalledWith(PLAN_ID);
    });

    it('C → S: UPDATE persists; audit row written; cache evicted for planId', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [existingRow('credit')] })
        .mockResolvedValueOnce({ rows: [existingRow('standard')] });

      await updatePlanBillingMode(PLAN_ID, 'standard', ACTOR_ID);

      expect(mockPoolQuery).toHaveBeenCalledTimes(2);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      const auditEntry = mockWriteAuditEntry.mock.calls[0]![0];
      expect(auditEntry.new_values).toMatchObject({
        billing_mode: 'standard',
        event: 'plan.billing_mode.changed',
        from: 'credit',
        to: 'standard',
      });
      expect(mockClearCreditModeCacheEntry).toHaveBeenCalledWith(PLAN_ID);
    });
  });

  describe('validation', () => {
    it('throws 404 when the plan does not exist', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      await expect(updatePlanBillingMode(PLAN_ID, 'credit', ACTOR_ID)).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(mockWriteAuditEntry).not.toHaveBeenCalled();
      expect(mockClearCreditModeCacheEntry).not.toHaveBeenCalled();
    });

    it('throws 400 when newMode is an unrecognized value', async () => {
      await expect(
        updatePlanBillingMode(PLAN_ID, 'metered' as BillingMode, ACTOR_ID),
      ).rejects.toMatchObject({ statusCode: 400 });
      // Validation runs BEFORE the SELECT — pool not touched.
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });
  });
});
