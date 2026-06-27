// Authorized by HUB-1597 (E-BE-1 S14, CR-5) — unit tests for the pricing scenario split:
//   - fetchScenarioBaseline (impure): mocked pool returns known revenue/cost/sub counts
//   - computeScenario (pure): byte-identical idempotency + math correctness + validation
// The R1 idempotency contract sits on computeScenario; fetchScenarioBaseline is
// time-sensitive by design.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPoolQuery = vi.hoisted(() => vi.fn());
vi.mock('../../db/pool.js', () => ({ getPool: () => ({ query: mockPoolQuery }) }));

import {
  fetchScenarioBaseline,
  computeScenario,
  SCENARIO_DISCLAIMER,
  SCENARIO_MODEL_TYPE,
  type ScenarioBaseline,
} from '../analyticsService.js';

const FROZEN_BASELINE: ScenarioBaseline = {
  snapshotAt: '2026-06-27T00:00:00.000Z',
  productId: 'p1',
  revenueLast30dCents: 100_000, // $1000
  costLast30dCents: 40_000, // $400
  subscriptionCount: 100,
  elasticityCoefficient: -1.0,
  marginPct: 0.6,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchScenarioBaseline (HUB-1597, impure)', () => {
  it('aggregates revenue + cost + active sub count + computes baseline marginPct', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ revenue_cents: '100000' }] })
      .mockResolvedValueOnce({ rows: [{ cost_cents: '40000' }] })
      .mockResolvedValueOnce({ rows: [{ sub_count: '100' }] });

    const baseline = await fetchScenarioBaseline('p1');

    expect(baseline.productId).toBe('p1');
    expect(baseline.revenueLast30dCents).toBe(100_000);
    expect(baseline.costLast30dCents).toBe(40_000);
    expect(baseline.subscriptionCount).toBe(100);
    expect(baseline.elasticityCoefficient).toBe(-1.0); // HUB-1585 default
    expect(baseline.marginPct).toBe(0.6);
    expect(typeof baseline.snapshotAt).toBe('string');
  });

  it('zero revenue → marginPct null (no-signal baseline)', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ revenue_cents: '0' }] })
      .mockResolvedValueOnce({ rows: [{ cost_cents: '500' }] })
      .mockResolvedValueOnce({ rows: [{ sub_count: '0' }] });

    const baseline = await fetchScenarioBaseline('p-quiet');
    expect(baseline.marginPct).toBeNull();
  });

  it('queries WHERE product_id = $1 across all three sources', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ revenue_cents: '0' }] })
      .mockResolvedValueOnce({ rows: [{ cost_cents: '0' }] })
      .mockResolvedValueOnce({ rows: [{ sub_count: '0' }] });

    await fetchScenarioBaseline('p-check');
    for (const call of mockPoolQuery.mock.calls) {
      const [, params] = call;
      expect(params[0]).toBe('p-check');
    }
  });
});

describe('computeScenario (HUB-1597, pure)', () => {
  describe('idempotency — R1 core correctness contract', () => {
    it('same baseline + same input → byte-identical output across calls', () => {
      const input = { priceChangePercent: 10, churnAssumptionPercent: 5 };
      const a = computeScenario(FROZEN_BASELINE, input);
      const b = computeScenario(FROZEN_BASELINE, input);

      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });

    it('different inputs → different outputs (proves the function is responsive, not constant)', () => {
      const a = computeScenario(FROZEN_BASELINE, { priceChangePercent: 0, churnAssumptionPercent: 0 });
      const b = computeScenario(FROZEN_BASELINE, { priceChangePercent: 10, churnAssumptionPercent: 0 });

      expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    });
  });

  describe('math', () => {
    it('0% price + 0% churn → scenario equals baseline (zero delta)', () => {
      const result = computeScenario(FROZEN_BASELINE, {
        priceChangePercent: 0,
        churnAssumptionPercent: 0,
      });

      expect(result.scenario.revenueCents).toBe(FROZEN_BASELINE.revenueLast30dCents);
      expect(result.scenario.subscriptionCount).toBe(FROZEN_BASELINE.subscriptionCount);
      expect(result.delta.revenueCents).toBe(0);
      expect(result.delta.subscriptionCount).toBe(0);
    });

    it('+10% price + -1.0 elasticity + 0% churn → revenue change matches model', () => {
      // elasticity factor = 1 + (-1.0)(0.10) = 0.90; churn factor = 1.0
      // scenarioSubs = 100 × 1.0 × 0.90 = 90
      // priceFactor = 1.10; scenarioRevenue = 100000 × 1.10 × 0.90 = 99000
      const result = computeScenario(FROZEN_BASELINE, {
        priceChangePercent: 10,
        churnAssumptionPercent: 0,
      });

      expect(result.scenario.subscriptionCount).toBe(90);
      expect(result.scenario.revenueCents).toBe(99_000);
      expect(result.delta.revenueCents).toBe(-1_000);
      expect(result.delta.subscriptionCount).toBe(-10);
    });

    it('-10% price + -1.0 elasticity + 0% churn → revenue change matches model', () => {
      // elasticity factor = 1 + (-1.0)(-0.10) = 1.10; churn factor = 1.0
      // scenarioSubs = 100 × 1.0 × 1.10 = 110
      // priceFactor = 0.90; scenarioRevenue = 100000 × 0.90 × 1.10 = 99000
      const result = computeScenario(FROZEN_BASELINE, {
        priceChangePercent: -10,
        churnAssumptionPercent: 0,
      });

      expect(result.scenario.subscriptionCount).toBe(110);
      expect(result.scenario.revenueCents).toBe(99_000);
    });

    it('cost is held constant (v0.1 simplification)', () => {
      const result = computeScenario(FROZEN_BASELINE, {
        priceChangePercent: 50,
        churnAssumptionPercent: 25,
      });
      expect(result.scenario.costCents).toBe(FROZEN_BASELINE.costLast30dCents);
      expect(result.delta.costCents).toBe(0);
    });

    it('subscription count zero → degenerate scenario (zero revenue, no scaling)', () => {
      const empty: ScenarioBaseline = {
        ...FROZEN_BASELINE,
        revenueLast30dCents: 0,
        subscriptionCount: 0,
        marginPct: null,
      };
      const result = computeScenario(empty, { priceChangePercent: 20, churnAssumptionPercent: 0 });
      expect(result.scenario.subscriptionCount).toBe(0);
      expect(result.scenario.revenueCents).toBe(0);
      expect(result.scenario.marginPct).toBeNull();
    });

    it('always includes modelType + disclaimer constants', () => {
      const result = computeScenario(FROZEN_BASELINE, {
        priceChangePercent: 5,
        churnAssumptionPercent: 0,
      });
      expect(result.modelType).toBe(SCENARIO_MODEL_TYPE);
      expect(result.disclaimer).toBe(SCENARIO_DISCLAIMER);
    });

    it('marginPctPoints delta is null when either baseline or scenario margin is null', () => {
      const zeroBaseline: ScenarioBaseline = {
        ...FROZEN_BASELINE,
        revenueLast30dCents: 0,
        marginPct: null,
      };
      const result = computeScenario(zeroBaseline, {
        priceChangePercent: 0,
        churnAssumptionPercent: 0,
      });
      expect(result.delta.marginPctPoints).toBeNull();
    });
  });

  describe('validation', () => {
    it('throws 400 when priceChangePercent <= -100 (can\'t drop price by 100%+)', () => {
      expect(() =>
        computeScenario(FROZEN_BASELINE, { priceChangePercent: -100, churnAssumptionPercent: 0 }),
      ).toThrow(/greater than -100/);
      expect(() =>
        computeScenario(FROZEN_BASELINE, { priceChangePercent: -150, churnAssumptionPercent: 0 }),
      ).toThrow(/greater than -100/);
    });

    it('throws 400 when churnAssumptionPercent is outside 0..100', () => {
      expect(() =>
        computeScenario(FROZEN_BASELINE, { priceChangePercent: 0, churnAssumptionPercent: -1 }),
      ).toThrow(/between 0 and 100/);
      expect(() =>
        computeScenario(FROZEN_BASELINE, { priceChangePercent: 0, churnAssumptionPercent: 150 }),
      ).toThrow(/between 0 and 100/);
    });
  });
});
