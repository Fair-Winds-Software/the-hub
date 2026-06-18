// Authorized by HUB-1141 — AdvisorRecommendation + AdvisorOutcome types; DB persistence
// Authorized by HUB-1142 — runAdvisor(): 5-step engine; confidence, cost projection, recommendation logic
// Authorized by HUB-1143 — getLatestRecommendation(): Redis 60s cache; stale flag
// Authorized by HUB-1144 — recordOutcome(): outcome write; parent status update; cache invalidation
// Authorized by HUB-1145 — runWeeklyAdvisor(): batch runner for all active (product, tenant) pairs
import { getPool } from '../db/pool.js';
import { getRedisClient } from '../redis/client.js';
import { getActivePricingModel } from './pricingModelService.js';
import logger from '../lib/logger.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type RecommendationType = 'upgrade' | 'downgrade' | 'switch_to_annual' | 'stay';
export type AdvisorConfidence = 'high' | 'medium' | 'low';
export type RecommendationStatus = 'open' | 'applied' | 'dismissed' | 'superseded';
export type OutcomeType = 'applied' | 'dismissed' | 'auto_detected';

export interface AdvisorRecommendation {
  id: string;
  product_id: string;
  tenant_id: string;
  recommendation_type: RecommendationType;
  suggested_plan_id: string | null;
  rationale: string;
  confidence: AdvisorConfidence;
  status: RecommendationStatus;
  week_start: string;
  projected_monthly_delta_cents: number | null;
  periods_analyzed: number;
  created_at: Date;
  updated_at: Date;
}

export interface AdvisorOutcome {
  id: string;
  recommendation_id: string;
  check_date: string;
  outcome_type: OutcomeType;
  outcome_value: unknown;
  notes: string | null;
  created_at: Date;
}

export interface AdvisorResult {
  recommendation_type: RecommendationType;
  suggested_plan_id: string | null;
  rationale: string;
  confidence: AdvisorConfidence;
  projected_monthly_delta_cents: number | null;
  periods_analyzed: number;
  week_start: string;
  recommendation: AdvisorRecommendation;
}

interface BillingPeriod {
  period_start: Date;
  period_end: Date;
  total_cost_cents: number;
  total_units: number;
  included_units: number;
  overage_units: number;
}

// ── Cache helpers ─────────────────────────────────────────────────────────────

function advisorCacheKey(productId: string, tenantId: string): string {
  return `hub:advisor:latest:${productId}:${tenantId}`;
}

async function invalidateAdvisorCache(productId: string, tenantId: string): Promise<void> {
  try {
    const redis = getRedisClient();
    await redis.del(advisorCacheKey(productId, tenantId));
  } catch (err) {
    logger.warn({ err, productId, tenantId }, 'Advisor cache invalidation failed — not critical');
  }
}

// ── getCurrentWeekStart: Monday of current UTC week ───────────────────────────

function getCurrentWeekStart(): Date {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon ... 6=Sat
  const diff = day === 0 ? 6 : day - 1; // days since Monday
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diff));
  return monday;
}

function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ── Step 1: Fetch last N closed billing periods ───────────────────────────────

async function fetchRecentPeriods(
  tenantId: string,
  productId: string,
  n = 6,
): Promise<BillingPeriod[]> {
  const pool = getPool();

  // Get the active pricing model to determine included_units (for overage detection)
  const model = await getActivePricingModel(productId);
  const includedUnits: number =
    model
      ? (model.config.included_units as number | undefined) ??
        (model.config.seat_count as number | undefined) ??
        0
      : 0;

  const { rows } = await pool.query<{
    period_start: Date;
    period_end: Date;
    total_cost_cents: string;
    total_units: string;
  }>(
    `SELECT period_start, period_end, total_cost_cents, total_units
     FROM billing_period_costs
     WHERE tenant_id = $1 AND product_id = $2
     ORDER BY period_start DESC
     LIMIT $3`,
    [tenantId, productId, n],
  );

  return rows.map((r) => {
    const units = parseInt(r.total_units, 10);
    const overage = Math.max(0, units - includedUnits);
    return {
      period_start: r.period_start,
      period_end: r.period_end,
      total_cost_cents: parseInt(r.total_cost_cents, 10),
      total_units: units,
      included_units: includedUnits,
      overage_units: overage,
    };
  });
}

// ── Step 2: Compute utilisation & trend ──────────────────────────────────────

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

  return {
    avgUtilisationPct: totalUtilPct / periods.length,
    overageMonths,
    stableMonths,
    avgCostCents,
  };
}

// ── Step 3: Project cost on available plans ────────────────────────────────────

interface PlanProjection {
  model_id: string;
  model_type: string;
  projected_cost_cents: number;
}

async function projectCosts(
  productId: string,
  avgUnits: number,
): Promise<PlanProjection[]> {
  const pool = getPool();

  const { rows } = await pool.query<{
    model_id: string;
    model_type: string;
    config: Record<string, unknown>;
  }>(
    `SELECT model_id, model_type, config
     FROM pricing_models
     WHERE product_id = $1
     ORDER BY activated_at DESC`,
    [productId],
  );

  return rows.map((m) => {
    let cost = 0;
    switch (m.model_type) {
      case 'flat_rate':
        cost = (m.config.price_cents as number | undefined) ?? 0;
        break;
      case 'usage_based':
        cost = Math.round(avgUnits * ((m.config.unit_price_cents as number | undefined) ?? 0));
        break;
      case 'per_seat':
        cost = Math.round(avgUnits * ((m.config.seat_price_cents as number | undefined) ?? 0));
        break;
      default:
        cost = 0;
    }
    return { model_id: m.model_id, model_type: m.model_type, projected_cost_cents: cost };
  });
}

// ── Step 4: Pick recommendation ───────────────────────────────────────────────

interface RecommendationDecision {
  recommendation_type: RecommendationType;
  suggested_plan_id: string | null;
  rationale: string;
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

  // Upgrade if 2+ months had overage
  if (stats.overageMonths >= 2) {
    const cheaperPlans = projections
      .filter((p) => p.model_id !== currentModelId && p.projected_cost_cents > currentCost)
      .sort((a, b) => a.projected_cost_cents - b.projected_cost_cents);
    const target = cheaperPlans[0] ?? null;
    return {
      recommendation_type: 'upgrade',
      suggested_plan_id: target?.model_id ?? null,
      rationale: `${stats.overageMonths} of the last ${periods.length} periods had overage usage, indicating the current plan is under-provisioned.`,
      projected_monthly_delta_cents: target ? target.projected_cost_cents - currentCost : null,
    };
  }

  // Downgrade if avg utilisation < 40%
  if (stats.avgUtilisationPct < 40 && periods.length >= 3) {
    const cheaperPlans = projections
      .filter((p) => p.model_id !== currentModelId && p.projected_cost_cents < currentCost)
      .sort((a, b) => a.projected_cost_cents - b.projected_cost_cents);
    const target = cheaperPlans[0] ?? null;
    return {
      recommendation_type: 'downgrade',
      suggested_plan_id: target?.model_id ?? null,
      rationale: `Average utilisation of ${stats.avgUtilisationPct.toFixed(1)}% over the last ${periods.length} periods is below 40%, suggesting a lower-tier plan may be sufficient.`,
      projected_monthly_delta_cents: target ? target.projected_cost_cents - currentCost : null,
    };
  }

  // Recommend annual if 3+ stable months
  if (stats.stableMonths >= 3) {
    return {
      recommendation_type: 'switch_to_annual',
      suggested_plan_id: null,
      rationale: `Usage has been stable for ${stats.stableMonths} consecutive periods without overage, making an annual commitment a cost-effective option.`,
      projected_monthly_delta_cents: null,
    };
  }

  // Stay
  return {
    recommendation_type: 'stay',
    suggested_plan_id: null,
    rationale: `Usage patterns over the last ${periods.length} periods do not indicate a clear benefit from a plan change at this time.`,
    projected_monthly_delta_cents: null,
  };
}

// ── Step 5: Confidence ────────────────────────────────────────────────────────

function deriveConfidence(periodCount: number): AdvisorConfidence {
  if (periodCount >= 5) return 'high';
  if (periodCount >= 3) return 'medium';
  return 'low';
}

// ── runAdvisor: orchestrates all 5 steps ──────────────────────────────────────

export async function runAdvisor(productId: string, tenantId: string): Promise<AdvisorResult> {
  const pool = getPool();

  // Steps 1 & 2
  const periods = await fetchRecentPeriods(tenantId, productId, 6);
  const stats = computeUtilisation(periods);
  const periodCount = periods.length;

  // Step 3
  const avgUnits = periodCount > 0
    ? periods.reduce((s, p) => s + p.total_units, 0) / periodCount
    : 0;
  const projections = await projectCosts(productId, avgUnits);

  // Active model for current plan reference
  const activeModel = await getActivePricingModel(productId);

  // Step 4
  const decision = decideRecommendation(stats, periods, activeModel?.model_id ?? null, projections);

  // Step 5
  const confidence = deriveConfidence(periodCount);
  const weekStart = toDateString(getCurrentWeekStart());

  // Upsert recommendation
  const { rows } = await pool.query<AdvisorRecommendation>(
    `INSERT INTO advisor_recommendations
       (product_id, tenant_id, recommendation_type, suggested_plan_id, rationale,
        confidence, status, week_start, projected_monthly_delta_cents, periods_analyzed)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8, $9)
     ON CONFLICT (product_id, tenant_id, week_start) DO UPDATE
       SET recommendation_type          = EXCLUDED.recommendation_type,
           suggested_plan_id            = EXCLUDED.suggested_plan_id,
           rationale                    = EXCLUDED.rationale,
           confidence                   = EXCLUDED.confidence,
           status                       = CASE
                                            WHEN advisor_recommendations.status = 'open'
                                            THEN 'open'::advisor_recommendation_status
                                            ELSE advisor_recommendations.status
                                          END,
           projected_monthly_delta_cents = EXCLUDED.projected_monthly_delta_cents,
           periods_analyzed             = EXCLUDED.periods_analyzed,
           updated_at                   = NOW()
     RETURNING *`,
    [
      productId,
      tenantId,
      decision.recommendation_type,
      decision.suggested_plan_id,
      decision.rationale,
      confidence,
      weekStart,
      decision.projected_monthly_delta_cents,
      periodCount,
    ],
  );

  const recommendation = rows[0]!;

  await invalidateAdvisorCache(productId, tenantId);

  logger.info(
    { productId, tenantId, type: decision.recommendation_type, confidence, weekStart },
    'Plan advisor recommendation generated',
  );

  return {
    recommendation_type: decision.recommendation_type,
    suggested_plan_id: decision.suggested_plan_id,
    rationale: decision.rationale,
    confidence,
    projected_monthly_delta_cents: decision.projected_monthly_delta_cents,
    periods_analyzed: periodCount,
    week_start: weekStart,
    recommendation,
  };
}

// ── getLatestRecommendation: Redis 60s cache ──────────────────────────────────

export interface LatestRecommendationResult {
  recommendation: AdvisorRecommendation;
  stale: boolean;
}

export async function getLatestRecommendation(
  productId: string,
  tenantId: string,
): Promise<LatestRecommendationResult | null> {
  const cacheKey = advisorCacheKey(productId, tenantId);

  try {
    const redis = getRedisClient();
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as LatestRecommendationResult;
    }
  } catch (err) {
    logger.warn({ err, productId, tenantId }, 'Advisor cache read failed — falling back to DB');
  }

  const pool = getPool();
  const { rows } = await pool.query<AdvisorRecommendation>(
    `SELECT id, product_id, tenant_id, recommendation_type, suggested_plan_id, rationale,
            confidence, status, week_start, projected_monthly_delta_cents, periods_analyzed,
            created_at, updated_at
     FROM advisor_recommendations
     WHERE product_id = $1 AND tenant_id = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [productId, tenantId],
  );

  if (rows.length === 0) return null;

  const rec = rows[0]!;
  const weekStart = new Date(rec.week_start);
  const ageMs = Date.now() - weekStart.getTime();
  const stale = ageMs > 7 * 24 * 60 * 60 * 1_000;

  const result: LatestRecommendationResult = { recommendation: rec, stale };

  try {
    const redis = getRedisClient();
    await redis.setex(cacheKey, 60, JSON.stringify(result));
  } catch (err) {
    logger.warn({ err, productId, tenantId }, 'Advisor cache write failed — not critical');
  }

  return result;
}

// ── recordOutcome ──────────────────────────────────────────────────────────────

export interface RecordOutcomeInput {
  outcomeType: OutcomeType;
  outcomeValue?: unknown;
  notes?: string;
}

export async function recordOutcome(
  recommendationId: string,
  input: RecordOutcomeInput,
): Promise<AdvisorOutcome> {
  const pool = getPool();

  // Fetch the recommendation to get productId/tenantId for cache invalidation
  const { rows: recRows } = await pool.query<Pick<AdvisorRecommendation, 'id' | 'product_id' | 'tenant_id'>>(
    `SELECT id, product_id, tenant_id FROM advisor_recommendations WHERE id = $1`,
    [recommendationId],
  );
  if (recRows.length === 0) {
    throw Object.assign(new Error('Recommendation not found'), { statusCode: 404 });
  }
  const rec = recRows[0]!;

  // Determine new parent status: applied if outcome matches type, dismissed otherwise
  const newStatus: RecommendationStatus =
    input.outcomeType === 'applied' ? 'applied' : 'dismissed';

  const client = await pool.connect();
  let outcome: AdvisorOutcome;

  try {
    await client.query('BEGIN');

    const { rows: outcomeRows } = await client.query<AdvisorOutcome>(
      `INSERT INTO advisor_outcomes
         (recommendation_id, check_date, outcome_type, outcome_value, notes)
       VALUES ($1, CURRENT_DATE, $2, $3, $4)
       RETURNING *`,
      [
        recommendationId,
        input.outcomeType,
        input.outcomeValue !== undefined ? JSON.stringify(input.outcomeValue) : null,
        input.notes ?? null,
      ],
    );

    outcome = outcomeRows[0]!;

    await client.query(
      `UPDATE advisor_recommendations
       SET status = $2, updated_at = NOW()
       WHERE id = $1`,
      [recommendationId, newStatus],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await invalidateAdvisorCache(rec.product_id, rec.tenant_id);

  logger.info({ recommendationId, outcomeType: input.outcomeType, newStatus }, 'Advisor outcome recorded');

  return outcome;
}

// ── getPortfolioSummary: aggregate view across all (product, tenant) pairs ─────

export interface PortfolioSummary {
  total_products: number;
  open_recommendations: number;
  upgrade_count: number;
  downgrade_count: number;
  switch_to_annual_count: number;
  stay_count: number;
  high_confidence_count: number;
  rows: Array<{
    product_id: string;
    tenant_id: string;
    recommendation_type: RecommendationType;
    confidence: AdvisorConfidence;
    status: RecommendationStatus;
    week_start: string;
    projected_monthly_delta_cents: number | null;
  }>;
}

export async function getPortfolioSummary(): Promise<PortfolioSummary> {
  const pool = getPool();

  // Latest recommendation per (product, tenant)
  const { rows } = await pool.query<{
    product_id: string;
    tenant_id: string;
    recommendation_type: RecommendationType;
    confidence: AdvisorConfidence;
    status: RecommendationStatus;
    week_start: string;
    projected_monthly_delta_cents: string | null;
  }>(
    `SELECT DISTINCT ON (product_id, tenant_id)
            product_id, tenant_id, recommendation_type, confidence,
            status, week_start, projected_monthly_delta_cents
     FROM advisor_recommendations
     ORDER BY product_id, tenant_id, created_at DESC`,
  );

  const summary: PortfolioSummary = {
    total_products: rows.length,
    open_recommendations: rows.filter((r) => r.status === 'open').length,
    upgrade_count: rows.filter((r) => r.recommendation_type === 'upgrade').length,
    downgrade_count: rows.filter((r) => r.recommendation_type === 'downgrade').length,
    switch_to_annual_count: rows.filter((r) => r.recommendation_type === 'switch_to_annual').length,
    stay_count: rows.filter((r) => r.recommendation_type === 'stay').length,
    high_confidence_count: rows.filter((r) => r.confidence === 'high').length,
    rows: rows.map((r) => ({
      product_id: r.product_id,
      tenant_id: r.tenant_id,
      recommendation_type: r.recommendation_type,
      confidence: r.confidence,
      status: r.status,
      week_start: r.week_start,
      projected_monthly_delta_cents:
        r.projected_monthly_delta_cents !== null
          ? parseInt(r.projected_monthly_delta_cents, 10)
          : null,
    })),
  };

  return summary;
}

// ── runWeeklyAdvisor: BullMQ job runner ───────────────────────────────────────

export async function runWeeklyAdvisor(): Promise<void> {
  const pool = getPool();

  // Find all (product_id, tenant_id) pairs with billing activity in the last 90 days
  const { rows } = await pool.query<{ product_id: string; tenant_id: string }>(
    `SELECT DISTINCT product_id, tenant_id
     FROM billing_period_costs
     WHERE period_start >= NOW() - INTERVAL '90 days'`,
  );

  logger.info({ count: rows.length }, 'Weekly advisor run started');

  // Auto-detect outcomes for open recommendations older than 30 days
  const { rows: staleRecs } = await pool.query<{ id: string; product_id: string; tenant_id: string }>(
    `SELECT id, product_id, tenant_id
     FROM advisor_recommendations
     WHERE status = 'open'
       AND created_at < NOW() - INTERVAL '30 days'`,
  );

  for (const rec of staleRecs) {
    try {
      await recordOutcome(rec.id, {
        outcomeType: 'auto_detected',
        notes: 'Auto-detected: recommendation open for 30+ days without explicit action',
      });
    } catch (err) {
      logger.warn({ err, recommendationId: rec.id }, 'Auto-detect outcome failed — continuing');
    }
  }

  // Run advisor with max concurrency 10
  const concurrency = 10;
  let processed = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i += concurrency) {
    const batch = rows.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map((r) => runAdvisor(r.product_id, r.tenant_id)),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        processed++;
      } else {
        failed++;
        logger.warn({ err: result.reason }, 'Advisor run failed for pair — continuing');
      }
    }
  }

  logger.info(
    { total: rows.length, processed, failed, staleAutoDetected: staleRecs.length },
    'Weekly advisor run complete',
  );
}
