// Authorized by HUB-1805 (S3 of HUB-1785) — unit tests for ingestMetricBatch.
// PG pool is mocked so no DB round-trip fires; the product-existence check is
// injected per test. Verifies the drop-categories mandated by the S3 ACs and the
// happy-path INSERT wiring.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockClient = vi.hoisted(() => ({
  query: vi.fn(async () => ({ rows: [] })),
  release: vi.fn(),
}));
const mockPool = vi.hoisted(() => ({
  connect: vi.fn(async () => mockClient),
  query: vi.fn(async () => ({ rows: [] })),
}));

vi.mock('../../../db/pool.js', () => ({
  getPool: () => mockPool,
}));

const { ingestMetricBatch } = await import('../metricIngestService.js');

const NOW = new Date('2026-07-13T12:00:00Z');
const PRODUCT_A = '00000000-0000-4000-8000-000000000001';
const PRODUCT_B = '00000000-0000-4000-8000-000000000002';

function existsCheck(...ids: string[]): (input: string[]) => Promise<Set<string>> {
  return async () => new Set(ids);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ingestMetricBatch — happy path', () => {
  it('accepts a mixed int/float/enum batch and INSERTs in one transaction', async () => {
    const events = [
      {
        product_id: PRODUCT_A,
        metric_name: 'daily_active_users',
        value: 500,
        occurred_at: '2026-07-13T11:00:00Z',
      },
      {
        product_id: PRODUCT_A,
        metric_name: 'churn_rate',
        value: 0.031,
        occurred_at: '2026-07-13T11:00:00Z',
      },
      {
        product_id: PRODUCT_A,
        metric_name: 'app_health_status',
        value: 'ok',
        occurred_at: '2026-07-13T11:00:00Z',
      },
    ];
    const result = await ingestMetricBatch({
      events,
      productExistenceCheck: existsCheck(PRODUCT_A),
      now: NOW,
    });
    expect(result.accepted).toBe(3);
    expect(result.dropped).toEqual([]);
    // BEGIN + INSERT + COMMIT
    const calls = mockClient.query.mock.calls.map((c) => c[0]);
    expect(calls).toContain('BEGIN');
    expect(calls).toContain('COMMIT');
    const insertCall = mockClient.query.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).startsWith('INSERT INTO metric_events'),
    );
    expect(insertCall).toBeDefined();
    // 3 events × 6 params
    expect((insertCall![1] as unknown[]).length).toBe(18);
  });
});

describe('ingestMetricBatch — drop categories', () => {
  it("category=schema when the wire schema fails (missing product_id)", async () => {
    const result = await ingestMetricBatch({
      events: [{ metric_name: 'logins', value: 1, occurred_at: '2026-07-13T11:00:00Z' }],
      productExistenceCheck: existsCheck(PRODUCT_A),
      now: NOW,
    });
    expect(result.accepted).toBe(0);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]!.category).toBe('schema');
  });

  it("category=unknown_metric when the metric_name is not in the catalog", async () => {
    const result = await ingestMetricBatch({
      events: [
        {
          product_id: PRODUCT_A,
          metric_name: 'not_in_catalog',
          value: 1,
          occurred_at: '2026-07-13T11:00:00Z',
        },
      ],
      productExistenceCheck: existsCheck(PRODUCT_A),
      now: NOW,
    });
    expect(result.accepted).toBe(0);
    expect(result.dropped[0]!.category).toBe('unknown_metric');
    expect(result.dropped[0]!.metric_name).toBe('not_in_catalog');
  });

  it("category=value_type when the value doesn't match the catalog entry's type", async () => {
    const result = await ingestMetricBatch({
      events: [
        {
          product_id: PRODUCT_A,
          metric_name: 'mrr_cents',
          value: 49.99, // int metric — floats rejected
          occurred_at: '2026-07-13T11:00:00Z',
        },
      ],
      productExistenceCheck: existsCheck(PRODUCT_A),
      now: NOW,
    });
    expect(result.accepted).toBe(0);
    expect(result.dropped[0]!.category).toBe('value_type');
  });

  it('category=timestamp when occurred_at is >30d in the past', async () => {
    const stale = new Date(NOW.getTime() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const result = await ingestMetricBatch({
      events: [
        {
          product_id: PRODUCT_A,
          metric_name: 'logins',
          value: 1,
          occurred_at: stale,
        },
      ],
      productExistenceCheck: existsCheck(PRODUCT_A),
      now: NOW,
    });
    expect(result.accepted).toBe(0);
    expect(result.dropped[0]!.category).toBe('timestamp');
    expect(result.dropped[0]!.reason).toContain('past');
  });

  it('category=timestamp when occurred_at is >5m in the future', async () => {
    const future = new Date(NOW.getTime() + 10 * 60 * 1000).toISOString();
    const result = await ingestMetricBatch({
      events: [
        {
          product_id: PRODUCT_A,
          metric_name: 'logins',
          value: 1,
          occurred_at: future,
        },
      ],
      productExistenceCheck: existsCheck(PRODUCT_A),
      now: NOW,
    });
    expect(result.accepted).toBe(0);
    expect(result.dropped[0]!.category).toBe('timestamp');
    expect(result.dropped[0]!.reason).toContain('future');
  });

  it('category=unknown_product when the product_id does not exist', async () => {
    const result = await ingestMetricBatch({
      events: [
        {
          product_id: PRODUCT_B,
          metric_name: 'logins',
          value: 1,
          occurred_at: '2026-07-13T11:00:00Z',
        },
      ],
      productExistenceCheck: existsCheck(PRODUCT_A),
      now: NOW,
    });
    expect(result.accepted).toBe(0);
    expect(result.dropped[0]!.category).toBe('unknown_product');
  });
});

describe('ingestMetricBatch — partial acceptance', () => {
  it('accepts valid events and drops invalid ones from the same batch', async () => {
    const events = [
      {
        product_id: PRODUCT_A,
        metric_name: 'logins',
        value: 5,
        occurred_at: '2026-07-13T11:00:00Z',
      },
      {
        product_id: PRODUCT_A,
        metric_name: 'not_in_catalog',
        value: 1,
        occurred_at: '2026-07-13T11:00:00Z',
      },
      {
        product_id: PRODUCT_B, // unknown product
        metric_name: 'logins',
        value: 1,
        occurred_at: '2026-07-13T11:00:00Z',
      },
    ];
    const result = await ingestMetricBatch({
      events,
      productExistenceCheck: existsCheck(PRODUCT_A),
      now: NOW,
    });
    expect(result.accepted).toBe(1);
    expect(result.dropped).toHaveLength(2);
    const categories = result.dropped.map((d) => d.category).sort();
    expect(categories).toEqual(['unknown_metric', 'unknown_product']);
  });

  it('empty batch → zero accepted, zero dropped, no BEGIN', async () => {
    const result = await ingestMetricBatch({
      events: [],
      productExistenceCheck: existsCheck(PRODUCT_A),
      now: NOW,
    });
    expect(result.accepted).toBe(0);
    expect(result.dropped).toEqual([]);
    expect(mockClient.query).not.toHaveBeenCalled();
  });

  it('all dropped → no BEGIN', async () => {
    const result = await ingestMetricBatch({
      events: [
        {
          product_id: PRODUCT_A,
          metric_name: 'not_in_catalog',
          value: 1,
          occurred_at: '2026-07-13T11:00:00Z',
        },
      ],
      productExistenceCheck: existsCheck(PRODUCT_A),
      now: NOW,
    });
    expect(result.accepted).toBe(0);
    expect(mockClient.query).not.toHaveBeenCalled();
  });
});

describe('ingestMetricBatch — transaction rollback on insert failure', () => {
  it('rolls back and rethrows when the INSERT fails', async () => {
    mockClient.query.mockImplementation(async (sql: unknown) => {
      if (typeof sql === 'string' && sql.startsWith('INSERT')) {
        throw new Error('db exploded');
      }
      return { rows: [] };
    });
    await expect(
      ingestMetricBatch({
        events: [
          {
            product_id: PRODUCT_A,
            metric_name: 'logins',
            value: 1,
            occurred_at: '2026-07-13T11:00:00Z',
          },
        ],
        productExistenceCheck: existsCheck(PRODUCT_A),
        now: NOW,
      }),
    ).rejects.toThrow('db exploded');
    const calls = mockClient.query.mock.calls.map((c) => c[0]);
    expect(calls).toContain('BEGIN');
    expect(calls).toContain('ROLLBACK');
  });
});
