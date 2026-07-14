// Authorized by HUB-1807 (S5 of HUB-1785) — unit tests for computePortfolioSummary.
// PG pool is mocked; three query paths simulated (products list, headline daily rollups,
// hourly app_health_status). Verifies portfolio math (SUM for MRR/DAU, DAU-weighted
// churn) + missing-data behavior (per-product nulls; empty portfolio).
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockPool = vi.hoisted(() => ({
  query: vi.fn(async () => ({ rows: [] as unknown[] })),
}));
vi.mock('../../../db/pool.js', () => ({ getPool: () => mockPool }));

const { computePortfolioSummary } = await import('../portfolioSummaryService.js');

const NOW = new Date('2026-07-13T12:00:00Z');
const PROD_A = '00000000-0000-4000-8000-00000000000a';
const PROD_B = '00000000-0000-4000-8000-00000000000b';

function stubQueries(overrides: {
  products?: Array<{ id: string; name: string }>;
  daily?: Array<{ product_id: string; metric_name: string; value_num: string; bucket_start: Date }>;
  health?: Array<{ product_id: string; value_str: string; bucket_start: Date }>;
}) {
  const products = overrides.products ?? [];
  const daily = overrides.daily ?? [];
  const health = overrides.health ?? [];
  mockPool.query.mockImplementation(async (sql: unknown) => {
    const s = String(sql);
    if (s.includes('FROM products')) return { rows: products };
    if (s.includes("bucket_window = 'daily'")) return { rows: daily };
    if (s.includes("metric_name = 'app_health_status'")) return { rows: health };
    return { rows: [] };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('computePortfolioSummary — happy path', () => {
  it('aggregates SUM for MRR/DAU + DAU-weighted churn across products', async () => {
    const bucket = new Date('2026-07-13T00:00:00Z');
    stubQueries({
      products: [
        { id: PROD_A, name: 'ContentHelm' },
        { id: PROD_B, name: 'LaunchKit' },
      ],
      daily: [
        { product_id: PROD_A, metric_name: 'mrr_cents', value_num: '1000000', bucket_start: bucket },
        { product_id: PROD_A, metric_name: 'daily_active_users', value_num: '500', bucket_start: bucket },
        { product_id: PROD_A, metric_name: 'churn_rate', value_num: '0.02', bucket_start: bucket },
        { product_id: PROD_B, metric_name: 'mrr_cents', value_num: '2500000', bucket_start: bucket },
        { product_id: PROD_B, metric_name: 'daily_active_users', value_num: '1500', bucket_start: bucket },
        { product_id: PROD_B, metric_name: 'churn_rate', value_num: '0.05', bucket_start: bucket },
      ],
      health: [
        { product_id: PROD_A, value_str: 'ok', bucket_start: new Date('2026-07-13T11:00:00Z') },
        { product_id: PROD_B, value_str: 'degraded', bucket_start: new Date('2026-07-13T11:00:00Z') },
      ],
    });
    const summary = await computePortfolioSummary(NOW);
    expect(summary.mrr_cents).toBe(3_500_000);
    expect(summary.daily_active_users).toBe(2000);
    // DAU-weighted churn: (0.02 * 500 + 0.05 * 1500) / (500 + 1500) = (10 + 75) / 2000 = 0.0425
    expect(summary.churn_rate).toBeCloseTo(0.0425, 4);
    expect(summary.as_of).toBe(bucket.toISOString());

    const productA = summary.per_product.find((p) => p.product_id === PROD_A)!;
    expect(productA.mrr_cents).toBe(1_000_000);
    expect(productA.dau).toBe(500);
    expect(productA.churn_rate).toBeCloseTo(0.02, 6);
    expect(productA.health).toBe('ok');

    const productB = summary.per_product.find((p) => p.product_id === PROD_B)!;
    expect(productB.health).toBe('degraded');
  });
});

describe('computePortfolioSummary — missing data', () => {
  it("empty portfolio (no products) → all nulls + per_product: []", async () => {
    stubQueries({});
    const summary = await computePortfolioSummary(NOW);
    expect(summary.per_product).toEqual([]);
    expect(summary.mrr_cents).toBeNull();
    expect(summary.daily_active_users).toBeNull();
    expect(summary.churn_rate).toBeNull();
    expect(summary.as_of).toBe(NOW.toISOString());
  });

  it('product with no daily rollup → per_product entry has nulls; product excluded from sums', async () => {
    const bucket = new Date('2026-07-13T00:00:00Z');
    stubQueries({
      products: [
        { id: PROD_A, name: 'HasData' },
        { id: PROD_B, name: 'NoData' },
      ],
      daily: [
        { product_id: PROD_A, metric_name: 'mrr_cents', value_num: '1000', bucket_start: bucket },
        { product_id: PROD_A, metric_name: 'daily_active_users', value_num: '10', bucket_start: bucket },
      ],
    });
    const summary = await computePortfolioSummary(NOW);
    expect(summary.mrr_cents).toBe(1000); // Only PROD_A contributes
    expect(summary.daily_active_users).toBe(10);
    // Churn: neither product reported churn — portfolio churn is null.
    expect(summary.churn_rate).toBeNull();

    const noData = summary.per_product.find((p) => p.product_id === PROD_B)!;
    expect(noData.mrr_cents).toBeNull();
    expect(noData.dau).toBeNull();
    expect(noData.churn_rate).toBeNull();
    expect(noData.health).toBe('unknown'); // No health rollup
  });

  it("product with no health rollup within 24h → health='unknown'", async () => {
    stubQueries({
      products: [{ id: PROD_A, name: 'Solo' }],
      daily: [],
      health: [], // No rollup at all
    });
    const summary = await computePortfolioSummary(NOW);
    expect(summary.per_product[0]!.health).toBe('unknown');
  });
});
