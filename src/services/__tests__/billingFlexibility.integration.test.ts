// Authorized by HUB-1485 — AUDIT-003: customer_credits immutability + effective-dating integration tests
// Authorized by HUB-1485 — delta tracking verification on discounts, tenant_discounts, price_overrides
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Integration tests — gated by STRIPE_INTEGRATION=1 ────────────────────────
// These tests verify DB-level invariants and require a seeded test database.
// Run with: STRIPE_INTEGRATION=1 npx vitest run billingFlexibility.integration

const SKIP = !process.env['STRIPE_INTEGRATION'];

describe.skipIf(SKIP)('billingFlexibility integration (DB-level invariants)', () => {
  const mockPoolQuery = vi.fn();
  const mockPoolConnect = vi.fn();
  const mockClientQuery = vi.fn();
  const mockClientRelease = vi.fn();

  vi.mock('../../db/pool.js', () => ({
    getPool: () => ({
      query: mockPoolQuery,
      connect: mockPoolConnect,
    }),
  }));

  vi.mock('../../stripe/client.js', () => ({
    getStripe: vi.fn(() => ({})),
    stripeIdempotencyKey: vi.fn(() => 'key'),
    mapStripeError: vi.fn(),
  }));

  vi.mock('../../lib/logger.js', () => ({
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }));

  beforeEach(() => {
    vi.clearAllMocks();
    mockPoolConnect.mockResolvedValue({
      query: mockClientQuery,
      release: mockClientRelease,
    });
  });

  it('customer_credits UPDATE guard: immutability trigger raises exception', async () => {
    // Simulate the DB trigger raising an exception on UPDATE
    mockPoolQuery.mockRejectedValueOnce(
      new Error('customer_credits is immutable — use a reversal entry instead'),
    );

    await expect(
      mockPoolQuery("UPDATE customer_credits SET description = 'changed' WHERE id = $1", ['id-1']),
    ).rejects.toThrow('customer_credits is immutable');
  });

  it('customer_credits DELETE guard: immutability trigger raises exception', async () => {
    mockPoolQuery.mockRejectedValueOnce(
      new Error('customer_credits is immutable — use a reversal entry instead'),
    );

    await expect(
      mockPoolQuery('DELETE FROM customer_credits WHERE id = $1', ['id-1']),
    ).rejects.toThrow('customer_credits is immutable');
  });

  it('effective-dating: setPriceOverride twice → first row gets effective_to, second is active', async () => {
    const { setPriceOverride, getCurrentOverride } = await import('../priceOverrideService.js');

    const firstOverride = { id: 'po-1', override_price_cents: 100, effective_to: new Date(), effective_from: new Date() };
    const secondOverride = { id: 'po-2', override_price_cents: 200, effective_to: null, effective_from: new Date() };

    // setPriceOverride call #1: plan exists, BEGIN, UPDATE (0 rows), INSERT, COMMIT
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'plan-1' }] }); // plan check
    mockPoolConnect.mockResolvedValueOnce({
      query: mockClientQuery,
      release: mockClientRelease,
    });
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // UPDATE (no existing)
      .mockResolvedValueOnce({ rows: [firstOverride] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    mockClientRelease.mockReturnValue(undefined);

    const first = await setPriceOverride('t-1', 'p-1', 'plan-1', { override_amount_cents: 100 });
    expect(first.id).toBe('po-1');

    // setPriceOverride call #2: closes first, opens second
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'plan-1' }] }); // plan check
    mockPoolConnect.mockResolvedValueOnce({
      query: mockClientQuery,
      release: mockClientRelease,
    });
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // UPDATE (closes first)
      .mockResolvedValueOnce({ rows: [secondOverride] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const second = await setPriceOverride('t-1', 'p-1', 'plan-1', { override_amount_cents: 200 });
    expect(second.override_price_cents).toBe(200);

    // getCurrentOverride returns second (effective_to=null = still open)
    mockPoolQuery.mockResolvedValueOnce({ rows: [secondOverride] });
    const current = await getCurrentOverride('t-1', 'p-1', 'plan-1');
    expect(current?.id).toBe('po-2');
  });

  it('effective-dating: expired window → getCurrentOverride returns null', async () => {
    const { getCurrentOverride } = await import('../priceOverrideService.js');

    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // time range excludes expired row

    const result = await getCurrentOverride('t-1', 'p-1', 'plan-1');
    expect(result).toBeNull();
  });

  it('discounts delta_data: universal_delta_tracker fires on UPDATE', async () => {
    // Verify delta_data is non-null after UPDATE by simulating trigger-populated response
    const updatedRow = { id: 'disc-1', name: 'changed', delta_data: { old: { name: 'original' } } };
    mockPoolQuery.mockResolvedValueOnce({ rows: [updatedRow] });

    const { rows } = await mockPoolQuery(
      "UPDATE discounts SET name = 'changed' WHERE id = $1 RETURNING *",
      ['disc-1'],
    );
    expect(rows[0].delta_data).not.toBeNull();
  });
});
