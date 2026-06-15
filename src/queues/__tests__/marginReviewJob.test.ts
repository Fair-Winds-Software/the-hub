// Authorized by HUB-644 — unit tests: runPeriodicMarginReview(); pair iteration and failure isolation
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock setup ────────────────────────────────────────────────────────────────

const mockPoolQuery = vi.hoisted(() => vi.fn());
vi.mock('../../db/pool.js', () => ({
  getPool: () => ({ query: mockPoolQuery }),
}));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockEvaluateMargin = vi.hoisted(() => vi.fn());
vi.mock('../../services/marginService.js', () => ({
  evaluateMargin: mockEvaluateMargin,
}));

import { runPeriodicMarginReview } from '../marginReviewJob.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockEvaluateMargin.mockResolvedValue(undefined);
});

// ── Pair iteration ────────────────────────────────────────────────────────────

describe('runPeriodicMarginReview() — pair iteration', () => {
  it('calls evaluateMargin for every enabled margin_config pair', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { tenant_id: 'tenant-1', product_id: 'product-1' },
        { tenant_id: 'tenant-2', product_id: 'product-2' },
      ],
    });

    await runPeriodicMarginReview();

    expect(mockEvaluateMargin).toHaveBeenCalledTimes(2);
    expect(mockEvaluateMargin).toHaveBeenCalledWith('tenant-1', 'product-1');
    expect(mockEvaluateMargin).toHaveBeenCalledWith('tenant-2', 'product-2');
  });

  it('does nothing when no enabled margin_configs exist', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await runPeriodicMarginReview();

    expect(mockEvaluateMargin).not.toHaveBeenCalled();
  });

  it('queries only enabled configs (WHERE mc.enabled = true)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await runPeriodicMarginReview();

    const queryText: string = mockPoolQuery.mock.calls[0]![0] as string;
    expect(queryText).toContain('enabled = true');
  });
});

// ── Failure isolation ─────────────────────────────────────────────────────────

describe('runPeriodicMarginReview() — failure isolation', () => {
  it('continues processing remaining pairs when one pair fails', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { tenant_id: 'tenant-1', product_id: 'product-1' },
        { tenant_id: 'tenant-2', product_id: 'product-2' },
        { tenant_id: 'tenant-3', product_id: 'product-3' },
      ],
    });

    mockEvaluateMargin
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('DB timeout'))
      .mockResolvedValueOnce(undefined);

    await runPeriodicMarginReview();

    expect(mockEvaluateMargin).toHaveBeenCalledTimes(3);
  });

  it('does not throw when all pairs fail', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { tenant_id: 'tenant-1', product_id: 'product-1' },
        { tenant_id: 'tenant-2', product_id: 'product-2' },
      ],
    });

    mockEvaluateMargin.mockRejectedValue(new Error('Everything broken'));

    await expect(runPeriodicMarginReview()).resolves.not.toThrow();
  });

  it('resolves successfully even when the only pair fails', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ tenant_id: 'tenant-1', product_id: 'product-1' }],
    });

    mockEvaluateMargin.mockRejectedValueOnce(new Error('Pair failed'));

    const result = await runPeriodicMarginReview();

    expect(result).toBeUndefined();
  });
});
