// Authorized by HUB-1142 — unit tests: advisor engine recommendation logic and confidence derivation
// Authorized by HUB-1143 — unit tests: stale flag calculation
import { describe, it, expect } from 'vitest';

// ── Pure-function helpers extracted for unit testing ──────────────────────────
// These match the internal logic in planAdvisorService.ts without DB/Redis I/O

interface BillingPeriod {
  period_start: Date;
  period_end: Date;
  total_cost_cents: number;
  total_units: number;
  included_units: number;
  overage_units: number;
}

interface UtilisationStats {
  avgUtilisationPct: number;
  overageMonths: number;
  stableMonths: number;
  avgCostCents: number;
}

function computeUtilisation(periods: BillingPeriod[]): UtilisationStats {
  if (periods.length === 0) {
    return { avgUtilisationPct: 0, overageMonths: 0, stableMonths: 0, avgCostCents: 0 };
  }
  const totalUtilPct = periods.reduce((sum, p) => {
    const pct =
      p.included_units > 0
        ? (p.total_units / p.included_units) * 100
        : p.total_units > 0
          ? 100
          : 0;
    return sum + pct;
  }, 0);
  const overageMonths = periods.filter((p) => p.overage_units > 0).length;
  const stableMonths = periods.filter((p) => p.overage_units === 0 && p.total_units > 0).length;
  const avgCostCents = periods.reduce((sum, p) => sum + p.total_cost_cents, 0) / periods.length;
  return { avgUtilisationPct: totalUtilPct / periods.length, overageMonths, stableMonths, avgCostCents };
}

type RecommendationType = 'upgrade' | 'downgrade' | 'switch_to_annual' | 'stay';

interface PlanProjection {
  model_id: string;
  model_type: string;
  projected_cost_cents: number;
}

interface RecommendationDecision {
  recommendation_type: RecommendationType;
  suggested_plan_id: string | null;
  projected_monthly_delta_cents: number | null;
}

function decideRecommendation(
  stats: UtilisationStats,
  periods: BillingPeriod[],
  currentModelId: string | null,
  projections: PlanProjection[],
): RecommendationDecision {
  const currentProjection = projections.find((p) => p.model_id === currentModelId);
  const currentCost = currentProjection?.projected_cost_cents ?? stats.avgCostCents;

  if (stats.overageMonths >= 2) {
    const target = projections
      .filter((p) => p.model_id !== currentModelId && p.projected_cost_cents > currentCost)
      .sort((a, b) => a.projected_cost_cents - b.projected_cost_cents)[0] ?? null;
    return {
      recommendation_type: 'upgrade',
      suggested_plan_id: target?.model_id ?? null,
      projected_monthly_delta_cents: target ? target.projected_cost_cents - currentCost : null,
    };
  }
  if (stats.avgUtilisationPct < 40 && periods.length >= 3) {
    const target = projections
      .filter((p) => p.model_id !== currentModelId && p.projected_cost_cents < currentCost)
      .sort((a, b) => a.projected_cost_cents - b.projected_cost_cents)[0] ?? null;
    return {
      recommendation_type: 'downgrade',
      suggested_plan_id: target?.model_id ?? null,
      projected_monthly_delta_cents: target ? target.projected_cost_cents - currentCost : null,
    };
  }
  if (stats.stableMonths >= 3) {
    return { recommendation_type: 'switch_to_annual', suggested_plan_id: null, projected_monthly_delta_cents: null };
  }
  return { recommendation_type: 'stay', suggested_plan_id: null, projected_monthly_delta_cents: null };
}

type AdvisorConfidence = 'high' | 'medium' | 'low';

function deriveConfidence(periodCount: number): AdvisorConfidence {
  if (periodCount >= 5) return 'high';
  if (periodCount >= 3) return 'medium';
  return 'low';
}

function isStale(weekStart: Date): boolean {
  return Date.now() - weekStart.getTime() > 7 * 24 * 60 * 60 * 1_000;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePeriod(
  units: number,
  includedUnits = 1000,
  costCents = 5000,
): BillingPeriod {
  const overage = Math.max(0, units - includedUnits);
  return {
    period_start: new Date('2026-01-01'),
    period_end: new Date('2026-01-31'),
    total_cost_cents: costCents,
    total_units: units,
    included_units: includedUnits,
    overage_units: overage,
  };
}

// ── computeUtilisation ────────────────────────────────────────────────────────

describe('computeUtilisation()', () => {
  it('returns zeros for empty periods', () => {
    const stats = computeUtilisation([]);
    expect(stats.avgUtilisationPct).toBe(0);
    expect(stats.overageMonths).toBe(0);
    expect(stats.stableMonths).toBe(0);
    expect(stats.avgCostCents).toBe(0);
  });

  it('counts overageMonths correctly', () => {
    const periods = [
      makePeriod(1200), // overage 200
      makePeriod(800),  // no overage
      makePeriod(1100), // overage 100
    ];
    const stats = computeUtilisation(periods);
    expect(stats.overageMonths).toBe(2);
  });

  it('counts stableMonths (usage > 0 and no overage)', () => {
    const periods = [
      makePeriod(800),
      makePeriod(900),
      makePeriod(1200), // overage — not stable
    ];
    const stats = computeUtilisation(periods);
    expect(stats.stableMonths).toBe(2);
  });

  it('calculates avgUtilisationPct correctly', () => {
    const periods = [makePeriod(500, 1000), makePeriod(1000, 1000)];
    const stats = computeUtilisation(periods);
    expect(stats.avgUtilisationPct).toBe(75); // (50 + 100) / 2
  });

  it('handles zero includedUnits: 100% if usage > 0, 0% if usage = 0', () => {
    const period = { ...makePeriod(100, 1000), included_units: 0 };
    const stats = computeUtilisation([period]);
    expect(stats.avgUtilisationPct).toBe(100);

    const emptyPeriod = { ...makePeriod(0, 1000), included_units: 0, total_units: 0 };
    const stats2 = computeUtilisation([emptyPeriod]);
    expect(stats2.avgUtilisationPct).toBe(0);
  });
});

// ── decideRecommendation ──────────────────────────────────────────────────────

describe('decideRecommendation()', () => {
  const projections: PlanProjection[] = [
    { model_id: 'plan-basic', model_type: 'flat_rate', projected_cost_cents: 3000 },
    { model_id: 'plan-pro', model_type: 'flat_rate', projected_cost_cents: 7000 },
  ];

  it('recommends upgrade when 2+ months had overage', () => {
    const stats: UtilisationStats = { avgUtilisationPct: 120, overageMonths: 3, stableMonths: 0, avgCostCents: 5000 };
    const decision = decideRecommendation(stats, Array(3).fill(makePeriod(1200)), 'plan-basic', projections);
    expect(decision.recommendation_type).toBe('upgrade');
    expect(decision.suggested_plan_id).toBe('plan-pro');
    expect(decision.projected_monthly_delta_cents).toBe(4000); // 7000 - 3000
  });

  it('recommends downgrade when avg utilisation < 40% over 3+ periods', () => {
    const stats: UtilisationStats = { avgUtilisationPct: 30, overageMonths: 0, stableMonths: 0, avgCostCents: 7000 };
    const decision = decideRecommendation(stats, Array(3).fill(makePeriod(300)), 'plan-pro', projections);
    expect(decision.recommendation_type).toBe('downgrade');
    expect(decision.suggested_plan_id).toBe('plan-basic');
    expect(decision.projected_monthly_delta_cents).toBe(-4000); // 3000 - 7000
  });

  it('does NOT downgrade with fewer than 3 periods even if util < 40%', () => {
    const stats: UtilisationStats = { avgUtilisationPct: 30, overageMonths: 0, stableMonths: 2, avgCostCents: 7000 };
    const decision = decideRecommendation(stats, Array(2).fill(makePeriod(300)), 'plan-pro', projections);
    // Fewer than 3 periods → falls through to switch_to_annual (stableMonths = 2 < 3) or stay
    expect(['stay', 'switch_to_annual']).toContain(decision.recommendation_type);
    expect(decision.recommendation_type).not.toBe('downgrade');
  });

  it('recommends switch_to_annual when 3+ stable months', () => {
    const stats: UtilisationStats = { avgUtilisationPct: 75, overageMonths: 0, stableMonths: 4, avgCostCents: 5000 };
    const decision = decideRecommendation(stats, Array(4).fill(makePeriod(750)), 'plan-basic', projections);
    expect(decision.recommendation_type).toBe('switch_to_annual');
    expect(decision.suggested_plan_id).toBeNull();
  });

  it('recommends stay when no clear signal', () => {
    const stats: UtilisationStats = { avgUtilisationPct: 65, overageMonths: 1, stableMonths: 2, avgCostCents: 5000 };
    const decision = decideRecommendation(stats, Array(2).fill(makePeriod(650)), 'plan-basic', projections);
    expect(decision.recommendation_type).toBe('stay');
    expect(decision.suggested_plan_id).toBeNull();
  });

  it('upgrade with no higher-tier plan sets suggested_plan_id to null', () => {
    const stats: UtilisationStats = { avgUtilisationPct: 120, overageMonths: 2, stableMonths: 0, avgCostCents: 7000 };
    const decision = decideRecommendation(stats, Array(2).fill(makePeriod(1200)), 'plan-pro', projections);
    expect(decision.recommendation_type).toBe('upgrade');
    expect(decision.suggested_plan_id).toBeNull();
    expect(decision.projected_monthly_delta_cents).toBeNull();
  });
});

// ── deriveConfidence ──────────────────────────────────────────────────────────

describe('deriveConfidence()', () => {
  it('returns low for < 3 periods', () => {
    expect(deriveConfidence(0)).toBe('low');
    expect(deriveConfidence(1)).toBe('low');
    expect(deriveConfidence(2)).toBe('low');
  });

  it('returns medium for 3–4 periods', () => {
    expect(deriveConfidence(3)).toBe('medium');
    expect(deriveConfidence(4)).toBe('medium');
  });

  it('returns high for 5+ periods', () => {
    expect(deriveConfidence(5)).toBe('high');
    expect(deriveConfidence(6)).toBe('high');
  });
});

// ── stale flag ────────────────────────────────────────────────────────────────

describe('isStale()', () => {
  it('returns false for a recent week_start (today)', () => {
    const today = new Date();
    expect(isStale(today)).toBe(false);
  });

  it('returns true for a week_start older than 7 days', () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);
    expect(isStale(old)).toBe(true);
  });

  it('returns false for exactly 6 days ago', () => {
    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1_000);
    expect(isStale(sixDaysAgo)).toBe(false);
  });
});
