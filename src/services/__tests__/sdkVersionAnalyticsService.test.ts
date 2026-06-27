// Authorized by HUB-1698 (E-BE-1 S21) — unit tests for the SDK version analytics
// aggregator. Mocks pool + getSetting (stale threshold). Covers:
//   - getDistribution: SQL filter by sdk_name, count parsing, products array
//   - getProductBreakdown: status classification matrix (current / behind / eol / stale)
//     and the documented priority (eol > stale > behind > current)
//   - getImpactPreview: <= filter on sdk_version
//   - getSetting fallback to default 30 when missing or non-number
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPoolQuery = vi.hoisted(() => vi.fn());
vi.mock('../../db/pool.js', () => ({ getPool: () => ({ query: mockPoolQuery }) }));

const mockGetSetting = vi.hoisted(() => vi.fn());
vi.mock('../adminSettings.js', () => ({ getSetting: mockGetSetting }));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  getDistribution,
  getProductBreakdown,
  getImpactPreview,
} from '../sdkVersionAnalyticsService.js';

const SDK = 'hub-sdk';
const NOW = Date.now();

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSetting.mockResolvedValue(30); // default stale threshold
});

describe('getDistribution (HUB-1698)', () => {
  it('filters by sdk_name + groups by version + parses count', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { version: '1.1.0', count: '3', products: ['Alpha', 'Beta', 'Gamma'] },
        { version: '1.0.0', count: '1', products: ['Delta'] },
      ],
    });

    const result = await getDistribution(SDK);

    const [sql, params] = mockPoolQuery.mock.calls[0]!;
    expect(sql).toMatch(/FROM sdk_version_reports/);
    expect(sql).toMatch(/JOIN product_registrations/);
    expect(sql).toMatch(/JOIN products/);
    expect(sql).toMatch(/WHERE r\.sdk_name = \$1/);
    expect(sql).toMatch(/GROUP BY r\.sdk_version/);
    expect(params).toEqual([SDK]);

    expect(result).toEqual([
      { version: '1.1.0', count: 3, products: ['Alpha', 'Beta', 'Gamma'] },
      { version: '1.0.0', count: 1, products: ['Delta'] },
    ]);
  });

  it('handles null products aggregate (LEFT JOIN edge)', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ version: '1.0.0', count: '0', products: null }],
    });

    const result = await getDistribution(SDK);
    expect(result[0]!.products).toEqual([]);
  });
});

describe('getProductBreakdown (HUB-1698)', () => {
  function setupRegistry(rows: Array<{
    version: string;
    is_latest: boolean;
    eol_at: Date | null;
    released_at: Date;
  }>) {
    mockPoolQuery.mockResolvedValueOnce({ rows });
  }

  function setupReports(rows: Array<{
    product_id: string;
    product_name: string;
    current_version: string;
    last_reported_at: Date;
  }>) {
    mockPoolQuery.mockResolvedValueOnce({ rows });
  }

  it('classifies current when version = is_latest', async () => {
    setupRegistry([
      { version: '1.1.0', is_latest: true, eol_at: null, released_at: new Date('2026-06-01') },
    ]);
    setupReports([
      {
        product_id: 'p1',
        product_name: 'Alpha',
        current_version: '1.1.0',
        last_reported_at: new Date(NOW - 1 * 24 * 60 * 60 * 1000), // 1 day ago — not stale
      },
    ]);

    const result = await getProductBreakdown(SDK);
    expect(result[0]!.status).toBe('current');
    expect(result[0]!.daysBehindLatest).toBe(0);
  });

  it('classifies behind when version known but not latest, fresh report', async () => {
    setupRegistry([
      { version: '1.1.0', is_latest: true, eol_at: null, released_at: new Date('2026-06-01') },
      { version: '1.0.0', is_latest: false, eol_at: null, released_at: new Date('2026-05-01') },
    ]);
    setupReports([
      {
        product_id: 'p1',
        product_name: 'Alpha',
        current_version: '1.0.0',
        last_reported_at: new Date(NOW - 1 * 24 * 60 * 60 * 1000),
      },
    ]);

    const result = await getProductBreakdown(SDK);
    expect(result[0]!.status).toBe('behind');
    // released_at diff = 31 days
    expect(result[0]!.daysBehindLatest).toBe(31);
  });

  it('classifies eol when registry row has eol_at (priority over stale + behind)', async () => {
    setupRegistry([
      { version: '1.1.0', is_latest: true, eol_at: null, released_at: new Date('2026-06-01') },
      {
        version: '1.0.0',
        is_latest: false,
        eol_at: new Date('2026-05-15'),
        released_at: new Date('2026-05-01'),
      },
    ]);
    setupReports([
      {
        product_id: 'p1',
        product_name: 'Alpha',
        current_version: '1.0.0',
        // 90 days ago — would normally be stale, but EOL wins
        last_reported_at: new Date(NOW - 90 * 24 * 60 * 60 * 1000),
      },
    ]);

    const result = await getProductBreakdown(SDK);
    expect(result[0]!.status).toBe('eol');
  });

  it('classifies stale when report > threshold ago (orthogonal to version state)', async () => {
    setupRegistry([
      { version: '1.1.0', is_latest: true, eol_at: null, released_at: new Date('2026-06-01') },
    ]);
    setupReports([
      {
        product_id: 'p1',
        product_name: 'Alpha',
        current_version: '1.1.0', // would be 'current' but report is stale
        last_reported_at: new Date(NOW - 60 * 24 * 60 * 60 * 1000), // 60 days > 30 threshold
      },
    ]);

    const result = await getProductBreakdown(SDK);
    expect(result[0]!.status).toBe('stale');
  });

  it('stale wins over behind (priority eol > stale > behind > current)', async () => {
    setupRegistry([
      { version: '1.1.0', is_latest: true, eol_at: null, released_at: new Date('2026-06-01') },
      { version: '1.0.0', is_latest: false, eol_at: null, released_at: new Date('2026-05-01') },
    ]);
    setupReports([
      {
        product_id: 'p1',
        product_name: 'Alpha',
        current_version: '1.0.0',
        last_reported_at: new Date(NOW - 60 * 24 * 60 * 60 * 1000),
      },
    ]);

    const result = await getProductBreakdown(SDK);
    expect(result[0]!.status).toBe('stale');
  });

  it('uses default 30-day threshold when getSetting throws', async () => {
    mockGetSetting.mockReset();
    mockGetSetting.mockRejectedValueOnce(new Error('Redis down'));

    setupRegistry([
      { version: '1.1.0', is_latest: true, eol_at: null, released_at: new Date('2026-06-01') },
    ]);
    setupReports([
      {
        product_id: 'p1',
        product_name: 'Alpha',
        current_version: '1.1.0',
        last_reported_at: new Date(NOW - 45 * 24 * 60 * 60 * 1000), // 45 > default 30 → stale
      },
    ]);

    const result = await getProductBreakdown(SDK);
    expect(result[0]!.status).toBe('stale');
  });

  it('uses default 30-day threshold when getSetting returns a non-number value', async () => {
    mockGetSetting.mockReset();
    mockGetSetting.mockResolvedValueOnce('not-a-number');

    setupRegistry([
      { version: '1.1.0', is_latest: true, eol_at: null, released_at: new Date('2026-06-01') },
    ]);
    setupReports([
      {
        product_id: 'p1',
        product_name: 'Alpha',
        current_version: '1.1.0',
        last_reported_at: new Date(NOW - 1 * 24 * 60 * 60 * 1000),
      },
    ]);

    const result = await getProductBreakdown(SDK);
    expect(result[0]!.status).toBe('current'); // 1 day ago < default 30 → not stale
  });
});

describe('getImpactPreview (HUB-1698)', () => {
  it('queries reports with sdk_version <= deprecatedVersion (lex compare)', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { product_id: 'p1', product_name: 'Alpha', current_version: '0.9.0' },
        { product_id: 'p2', product_name: 'Beta', current_version: '1.0.0' },
      ],
    });

    const result = await getImpactPreview(SDK, '1.0.0');

    const [sql, params] = mockPoolQuery.mock.calls[0]!;
    expect(sql).toMatch(/r\.sdk_name = \$1 AND r\.sdk_version <= \$2/);
    expect(params).toEqual([SDK, '1.0.0']);

    expect(result).toEqual({
      impactedCount: 2,
      products: [
        { productId: 'p1', productName: 'Alpha', currentVersion: '0.9.0' },
        { productId: 'p2', productName: 'Beta', currentVersion: '1.0.0' },
      ],
    });
  });

  it('returns zero count when no products match', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getImpactPreview(SDK, '0.5.0');
    expect(result).toEqual({ impactedCount: 0, products: [] });
  });
});
