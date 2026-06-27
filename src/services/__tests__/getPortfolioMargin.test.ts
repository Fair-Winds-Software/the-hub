// Authorized by HUB-1595 (E-BE-1 S12, CR-3) — unit tests for analyticsService.getPortfolioMargin
// covering the R1 zero-revenue matrix + threshold tuning + portfolio rollup + 4-decimal precision.
//
// pool + getSetting mocked; assertions focus on the pure compute layer (computeMargin
// branches + rollup) independent of the live invoices/billing_period_costs schema.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPoolQuery = vi.hoisted(() => vi.fn());
vi.mock('../../db/pool.js', () => ({ getPool: () => ({ query: mockPoolQuery }) }));

const mockGetSetting = vi.hoisted(() => vi.fn());
vi.mock('../adminSettings.js', () => ({ getSetting: mockGetSetting }));

import { getPortfolioMargin } from '../analyticsService.js';

const FROM = new Date('2026-05-01T00:00:00Z');
const TO = new Date('2026-05-31T23:59:59Z');

/**
 * Mock the 3 parallel queries: products → revenue → cost. Pool calls run in Promise.all,
 * but vitest's vi.fn() preserves call order regardless of resolve order.
 */
function mockPool(
  products: Array<{ id: string; name: string }>,
  revenue: Array<{ product_id: string; revenue_cents: string }>,
  cost: Array<{ product_id: string; cost_cents: string }>,
) {
  mockPoolQuery
    .mockResolvedValueOnce({ rows: products })
    .mockResolvedValueOnce({ rows: revenue })
    .mockResolvedValueOnce({ rows: cost });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSetting.mockResolvedValue(0.0); // R1 default threshold
});

describe('getPortfolioMargin (HUB-1595)', () => {
  describe('R1 zero-revenue matrix', () => {
    it('revenue=0 + cost=0 → no signal (marginPct null, losingMoney false)', async () => {
      mockPool(
        [{ id: 'p-quiet', name: 'Quiet' }],
        [],
        [],
      );

      const result = await getPortfolioMargin({ from: FROM, to: TO });
      const product = result.products[0]!;
      expect(product).toMatchObject({
        productId: 'p-quiet',
        revenueCents: 0,
        costCents: 0,
        marginPct: null,
        losingMoney: false,
      });
    });

    it('revenue=0 + cost>0 → losingMoney=TRUE (R1 FIX — was false in original spec)', async () => {
      mockPool(
        [{ id: 'p-burn', name: 'Burn' }],
        [],
        [{ product_id: 'p-burn', cost_cents: '500' }],
      );

      const result = await getPortfolioMargin({ from: FROM, to: TO });
      const product = result.products[0]!;
      expect(product.revenueCents).toBe(0);
      expect(product.costCents).toBe(500);
      expect(product.marginPct).toBeNull();
      expect(product.losingMoney).toBe(true);
    });

    it('break-even (marginPct=0) flags losingMoney=true via <= threshold (HUB-1585 B1 cascade)', async () => {
      mockPool(
        [{ id: 'p-even', name: 'Even' }],
        [{ product_id: 'p-even', revenue_cents: '1000' }],
        [{ product_id: 'p-even', cost_cents: '1000' }],
      );

      const result = await getPortfolioMargin({ from: FROM, to: TO });
      const product = result.products[0]!;
      expect(product.marginPct).toBe(0);
      expect(product.losingMoney).toBe(true); // 0 <= 0 threshold
    });

    it('healthy margin → losingMoney=false', async () => {
      mockPool(
        [{ id: 'p-healthy', name: 'Healthy' }],
        [{ product_id: 'p-healthy', revenue_cents: '10000' }],
        [{ product_id: 'p-healthy', cost_cents: '4000' }],
      );

      const result = await getPortfolioMargin({ from: FROM, to: TO });
      const product = result.products[0]!;
      expect(product.marginPct).toBe(0.6); // (10000-4000)/10000
      expect(product.losingMoney).toBe(false);
    });
  });

  describe('threshold tuning', () => {
    it('raising the threshold flips a previously-healthy product to losingMoney=true', async () => {
      mockGetSetting.mockResolvedValueOnce(0.5); // 50% threshold — strict
      mockPool(
        [{ id: 'p-thin', name: 'Thin' }],
        [{ product_id: 'p-thin', revenue_cents: '10000' }],
        [{ product_id: 'p-thin', cost_cents: '5500' }],
      );

      const result = await getPortfolioMargin({ from: FROM, to: TO });
      expect(result.threshold).toBe(0.5);
      const product = result.products[0]!;
      expect(product.marginPct).toBe(0.45); // (10000-5500)/10000 = 0.45
      expect(product.losingMoney).toBe(true); // 0.45 <= 0.5
    });

    it('falls back to default 0.0 when getSetting throws', async () => {
      mockGetSetting.mockRejectedValueOnce(new Error('Redis down'));
      mockPool(
        [{ id: 'p-fallback', name: 'Fallback' }],
        [{ product_id: 'p-fallback', revenue_cents: '10000' }],
        [{ product_id: 'p-fallback', cost_cents: '4000' }],
      );

      const result = await getPortfolioMargin({ from: FROM, to: TO });
      expect(result.threshold).toBe(0);
    });

    it('falls back to default 0.0 when getSetting returns a non-number value', async () => {
      mockGetSetting.mockResolvedValueOnce('not-a-number');
      mockPool([], [], []);
      const result = await getPortfolioMargin({ from: FROM, to: TO });
      expect(result.threshold).toBe(0);
    });
  });

  describe('portfolio rollup', () => {
    it('sums revenue + cost across products and recomputes the rollup margin', async () => {
      mockPool(
        [
          { id: 'p1', name: 'Alpha' },
          { id: 'p2', name: 'Beta' },
          { id: 'p3', name: 'Gamma' },
        ],
        [
          { product_id: 'p1', revenue_cents: '10000' },
          { product_id: 'p2', revenue_cents: '5000' },
          // p3 has no revenue row → falls through to 0
        ],
        [
          { product_id: 'p1', cost_cents: '4000' },
          { product_id: 'p2', cost_cents: '6000' },
          { product_id: 'p3', cost_cents: '500' },
        ],
      );

      const result = await getPortfolioMargin({ from: FROM, to: TO });

      expect(result.products).toHaveLength(3);
      expect(result.products[0]!.marginPct).toBe(0.6); // p1: healthy
      expect(result.products[1]!.marginPct).toBe(-0.2); // p2: losing
      expect(result.products[1]!.losingMoney).toBe(true);
      expect(result.products[2]!.marginPct).toBeNull(); // p3: 0 revenue + 500 cost
      expect(result.products[2]!.losingMoney).toBe(true);

      // Portfolio rollup: revenue=15000, cost=10500, marginPct=(15000-10500)/15000=0.3
      expect(result.portfolio).toMatchObject({
        revenueCents: 15000,
        costCents: 10500,
        marginPct: 0.3,
        losingMoney: false,
      });
    });

    it('portfolio with all-zero activity returns no-signal portfolio rollup', async () => {
      mockPool([{ id: 'p1', name: 'Quiet' }], [], []);
      const result = await getPortfolioMargin({ from: FROM, to: TO });
      expect(result.portfolio).toMatchObject({
        revenueCents: 0,
        costCents: 0,
        marginPct: null,
        losingMoney: false,
      });
    });
  });

  describe('precision + active filter', () => {
    it('rounds marginPct to 4 decimal places', async () => {
      mockPool(
        [{ id: 'p-prec', name: 'Prec' }],
        [{ product_id: 'p-prec', revenue_cents: '3' }],
        [{ product_id: 'p-prec', cost_cents: '1' }],
      );

      const result = await getPortfolioMargin({ from: FROM, to: TO });
      // (3-1)/3 = 0.666666... → 0.6667 (4-decimal half-away-from-zero via Math.round)
      expect(result.products[0]!.marginPct).toBe(0.6667);
    });

    it('queries products WHERE active = true (sanity that the SQL filter is in place)', async () => {
      mockPool([], [], []);
      await getPortfolioMargin({ from: FROM, to: TO });
      const [productsSql] = mockPoolQuery.mock.calls[0]!;
      expect(productsSql).toMatch(/active = true/);
    });

    it('returns generatedAt as an ISO8601 string', async () => {
      mockPool([], [], []);
      const result = await getPortfolioMargin({ from: FROM, to: TO });
      expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('throws 400 when the range exceeds 90 days', async () => {
      const from = new Date('2026-01-01T00:00:00Z');
      const to = new Date('2026-12-31T00:00:00Z');
      await expect(getPortfolioMargin({ from, to })).rejects.toMatchObject({
        statusCode: 400,
      });
    });
  });
});
