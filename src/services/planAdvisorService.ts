// Authorized by HUB-1141 — AdvisorRecommendation + AdvisorOutcome types; DB persistence
// Authorized by HUB-1142 — runAdvisor(): 5-step engine; confidence, cost projection, recommendation logic
// Authorized by HUB-1143 — getLatestRecommendation(): Redis 60s cache; stale flag
// Authorized by HUB-1144 — recordOutcome(): outcome write; parent status update; cache invalidation
// Authorized by HUB-1145 — runWeeklyAdvisor(): batch runner for all active (product, tenant) pairs
// Authorized by HUB-1148 — getBillingSummary(), addAuditNote(), getRecommendationHistory()
// Authorized by HUB-1149 — enhanced getPortfolioSummary(): MRR, health badges, churn risk, margin health; CSV export
import { getPool } from '../db/pool.js';
import { getRedisClient } from '../redis/client.js';
import { getActivePricingModel } from './pricingModelService.js';
import logger from '../lib/logger.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type RecommendationType = 'upgrade' | 'downgrade' | 'switch_to_annual' | 'stay';
export type AdvisorConfidence = 'high' | 'medium' | 'low';
export type RecommendationStatus = 'open' | 'applied' | 'dismissed' | 'superseded';
// HUB-1699 (E-BE-1 S22): widened with operator-captured outcome semantics. Existing
// applied/dismissed/auto_detected = HUB-observed auto-detection. New won/lost/no_action =
// operator explicitly captured the deal state. Status mapping in recordOutcome below.
export type OutcomeType =
  | 'applied'
  | 'dismissed'
  | 'auto_detected'
  | 'won'
  | 'lost'
  | 'no_action';

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

  // HUB-1771 Phase 4: pricing_models column is `id`, not `model_id`. Alias
  // so the projected typing / mapping code below keeps its existing name.
  const { rows } = await pool.query<{
    model_id: string;
    model_type: string;
    config: Record<string, unknown>;
  }>(
    `SELECT id AS model_id, model_type, config
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

  // Determine new parent status. HUB-1699 widens the mapping:
  //   applied / won           → 'applied'   (recommendation acted on)
  //   dismissed / auto_detected /
  //   lost / no_action        → 'dismissed' (terminal non-applied)
  const newStatus: RecommendationStatus =
    input.outcomeType === 'applied' || input.outcomeType === 'won'
      ? 'applied'
      : 'dismissed';

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

export type HealthBadge = 'green' | 'amber' | 'red';

export interface ProductCard {
  product_id: string;
  product_name: string;
  active_tenants: number;
  mrr_cents: number;
  open_recommendation_count: number;
  health_badge: HealthBadge;
}

export interface ChurnRiskRow {
  tenant_id: string;
  tenant_name: string;
  product_id: string;
  consecutive_stay_count: number;
  last_usage_pct: number | null;
}

export interface MarginHealthRow {
  discount_id: string;
  tenant_id: string;
  tenant_name: string;
  product_id: string;
  discount_type: string;
  discount_value: string;
  days_active: number;
  notes: string | null;
}

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
    tenant_name?: string;
    recommendation_type: RecommendationType;
    confidence: AdvisorConfidence;
    status: RecommendationStatus;
    week_start: string;
    projected_monthly_delta_cents: number | null;
  }>;
  product_cards: ProductCard[];
  churn_risk: ChurnRiskRow[];
  margin_health: MarginHealthRow[];
}

export async function getPortfolioSummary(): Promise<PortfolioSummary> {
  const pool = getPool();

  // Latest recommendation per (product, tenant) with tenant name
  const { rows } = await pool.query<{
    product_id: string;
    tenant_id: string;
    tenant_name: string;
    recommendation_type: RecommendationType;
    confidence: AdvisorConfidence;
    status: RecommendationStatus;
    week_start: string;
    projected_monthly_delta_cents: string | null;
  }>(
    `SELECT DISTINCT ON (ar.product_id, ar.tenant_id)
            ar.product_id, ar.tenant_id, t.name AS tenant_name,
            ar.recommendation_type, ar.confidence,
            ar.status, ar.week_start, ar.projected_monthly_delta_cents
     FROM advisor_recommendations ar
     JOIN tenants t ON t.id = ar.tenant_id
     ORDER BY ar.product_id, ar.tenant_id, ar.created_at DESC`,
  );

  // Per-product MRR: sum of latest billing cost per tenant per product
  const { rows: mrrRows } = await pool.query<{
    product_id: string;
    product_name: string;
    mrr_cents: string;
    active_tenants: string;
  }>(
    `SELECT
       p.id AS product_id,
       p.name AS product_name,
       COALESCE(SUM(latest_bpc.total_cost_cents), 0)::TEXT AS mrr_cents,
       COUNT(DISTINCT latest_bpc.tenant_id)::TEXT AS active_tenants
     FROM products p
     LEFT JOIN LATERAL (
       SELECT DISTINCT ON (tenant_id) tenant_id, total_cost_cents
       FROM billing_period_costs
       WHERE product_id = p.id
       ORDER BY tenant_id, period_start DESC
     ) latest_bpc ON true
     WHERE p.active = true
     GROUP BY p.id, p.name
     ORDER BY p.name`,
  );

  // Health badge logic per product
  const openByProduct = new Map<string, { upgrade: number; total: number; churn: number }>();
  for (const r of rows) {
    if (!openByProduct.has(r.product_id)) {
      openByProduct.set(r.product_id, { upgrade: 0, total: 0, churn: 0 });
    }
    const entry = openByProduct.get(r.product_id)!;
    entry.total++;
    if (r.status === 'open' && r.recommendation_type === 'upgrade') entry.upgrade++;
  }

  // Churn risk signals: tenants with 3+ consecutive Stay
  const { rows: churnRows } = await pool.query<{
    product_id: string;
    tenant_id: string;
    tenant_name: string;
    consecutive_stay_count: string;
  }>(
    `WITH last_recs AS (
       SELECT
         ar.product_id,
         ar.tenant_id,
         t.name AS tenant_name,
         ar.recommendation_type,
         ROW_NUMBER() OVER (PARTITION BY ar.product_id, ar.tenant_id ORDER BY ar.created_at DESC) AS rn
       FROM advisor_recommendations ar
       JOIN tenants t ON t.id = ar.tenant_id
     ),
     stay_streak AS (
       SELECT product_id, tenant_id, tenant_name, COUNT(*) AS cnt
       FROM last_recs
       WHERE rn <= 4 AND recommendation_type = 'stay'
       GROUP BY product_id, tenant_id, tenant_name
       HAVING COUNT(*) >= 3
     )
     SELECT product_id, tenant_id, tenant_name, cnt::TEXT AS consecutive_stay_count
     FROM stay_streak
     ORDER BY cnt DESC`,
  );

  // Add churn count to product badge calculation
  for (const cr of churnRows) {
    const entry = openByProduct.get(cr.product_id);
    if (entry) entry.churn++;
  }

  // Latest usage per churn-risk tenant
  const churnTenantKeys = churnRows.map((r) => `(${r.product_id}, ${r.tenant_id})`);
  const lastUsagePct = new Map<string, number>();
  if (churnRows.length > 0) {
    const { rows: usageRows } = await pool.query<{
      product_id: string;
      tenant_id: string;
      total_units: string;
    }>(
      `SELECT DISTINCT ON (tenant_id, product_id) tenant_id, product_id, total_units::TEXT
       FROM billing_period_costs
       WHERE (product_id, tenant_id) IN (
         SELECT product_id, tenant_id FROM advisor_recommendations
         WHERE product_id = ANY($1::uuid[]) AND tenant_id = ANY($2::uuid[])
       )
       ORDER BY tenant_id, product_id, period_start DESC`,
      [churnRows.map((r) => r.product_id), churnRows.map((r) => r.tenant_id)],
    );
    for (const u of usageRows) {
      lastUsagePct.set(`${u.product_id}:${u.tenant_id}`, parseInt(u.total_units, 10));
    }
  }

  // Mark churn count in badge for products
  void churnTenantKeys; // used implicitly via churnRows above

  // Margin health: active discounts > 90 days
  const { rows: marginRows } = await pool.query<{
    discount_id: string;
    tenant_id: string;
    tenant_name: string;
    product_id: string;
    discount_type: string;
    discount_value: string;
    days_active: string;
    notes: string | null;
  }>(
    `SELECT
       d.id AS discount_id,
       d.tenant_id,
       t.name AS tenant_name,
       d.product_id,
       d.discount_type::TEXT,
       d.discount_value::TEXT,
       EXTRACT(EPOCH FROM (NOW() - d.created_at)) / 86400 AS days_active,
       d.notes
     FROM tenant_discounts d
     JOIN tenants t ON t.id = d.tenant_id
     WHERE d.active = true
       AND d.created_at < NOW() - INTERVAL '90 days'
       AND (d.expiry_date IS NULL OR d.expiry_date > NOW())
     ORDER BY d.created_at ASC`,
  );

  // Compute health badges
  const productCards: ProductCard[] = mrrRows.map((p) => {
    const signals = openByProduct.get(p.product_id) ?? { upgrade: 0, total: 0, churn: 0 };
    const tenantCount = parseInt(p.active_tenants, 10) || signals.total || 1;
    const upgradeRatio = signals.upgrade / tenantCount;
    const churnRatio = signals.churn / tenantCount;

    let health_badge: HealthBadge = 'green';
    if (churnRatio > 0.05) {
      health_badge = 'red';
    } else if (upgradeRatio > 0.1) {
      health_badge = 'amber';
    }

    return {
      product_id: p.product_id,
      product_name: p.product_name,
      active_tenants: parseInt(p.active_tenants, 10),
      mrr_cents: parseInt(p.mrr_cents, 10),
      open_recommendation_count: signals.upgrade,
      health_badge,
    };
  });

  const summary: PortfolioSummary = {
    total_products: mrrRows.length,
    open_recommendations: rows.filter((r) => r.status === 'open').length,
    upgrade_count: rows.filter((r) => r.recommendation_type === 'upgrade').length,
    downgrade_count: rows.filter((r) => r.recommendation_type === 'downgrade').length,
    switch_to_annual_count: rows.filter((r) => r.recommendation_type === 'switch_to_annual').length,
    stay_count: rows.filter((r) => r.recommendation_type === 'stay').length,
    high_confidence_count: rows.filter((r) => r.confidence === 'high').length,
    rows: rows.map((r) => ({
      product_id: r.product_id,
      tenant_id: r.tenant_id,
      tenant_name: r.tenant_name,
      recommendation_type: r.recommendation_type,
      confidence: r.confidence,
      status: r.status,
      week_start: r.week_start,
      projected_monthly_delta_cents:
        r.projected_monthly_delta_cents !== null
          ? parseInt(r.projected_monthly_delta_cents, 10)
          : null,
    })),
    product_cards: productCards,
    churn_risk: churnRows.map((r) => ({
      tenant_id: r.tenant_id,
      tenant_name: r.tenant_name,
      product_id: r.product_id,
      consecutive_stay_count: parseInt(r.consecutive_stay_count, 10),
      last_usage_pct: lastUsagePct.get(`${r.product_id}:${r.tenant_id}`) ?? null,
    })),
    margin_health: marginRows.map((r) => ({
      discount_id: r.discount_id,
      tenant_id: r.tenant_id,
      tenant_name: r.tenant_name,
      product_id: r.product_id,
      discount_type: r.discount_type,
      discount_value: r.discount_value,
      days_active: Math.floor(parseFloat(r.days_active)),
      notes: r.notes,
    })),
  };

  return summary;
}

// ── getBillingSummary: last 6 billing periods with usage vs included ──────────

export interface BillingSummaryPeriod {
  period_start: string;
  period_end: string;
  total_units: number;
  total_cost_cents: number;
  included_units: number;
  overage_units: number;
  utilisation_pct: number;
}

export async function getBillingSummary(
  productId: string,
  tenantId: string,
): Promise<BillingSummaryPeriod[]> {
  const periods = await fetchRecentPeriods(tenantId, productId, 6);
  return periods.map((p) => {
    const utilPct =
      p.included_units > 0
        ? (p.total_units / p.included_units) * 100
        : p.total_units > 0
          ? 100
          : 0;
    return {
      period_start: p.period_start.toISOString(),
      period_end: p.period_end.toISOString(),
      total_units: p.total_units,
      total_cost_cents: p.total_cost_cents,
      included_units: p.included_units,
      overage_units: p.overage_units,
      utilisation_pct: Math.round(utilPct * 10) / 10,
    };
  });
}

// ── addAuditNote: write a note to operator_audit_log for a recommendation ─────

export async function addAuditNote(
  recommendationId: string,
  note: string,
  operatorId?: string,
): Promise<{ id: string; created_at: string }> {
  const pool = getPool();

  // Verify recommendation exists
  const { rows: recRows } = await pool.query<{ id: string; product_id: string; tenant_id: string }>(
    `SELECT id, product_id, tenant_id FROM advisor_recommendations WHERE id = $1`,
    [recommendationId],
  );
  if (recRows.length === 0) {
    throw Object.assign(new Error('Recommendation not found'), { statusCode: 404 });
  }
  const rec = recRows[0]!;

  // HUB-1771 Phase 4: reusing $2 for both entity_id and recommendation_id makes pg
  // fail type deduction ("inconsistent types deduced for parameter $2") when the two
  // columns have different underlying types (entity_id is UUID, recommendation_id is
  // UUID with NULL allowed). Cast the second usage explicitly.
  const { rows } = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO operator_audit_log
       (operator_id, entity_type, entity_id, action, notes, tenant_id, product_id, recommendation_id)
     VALUES ($1, 'advisor_recommendation', $2::uuid, 'audit_note', $3, $4, $5, $2::uuid)
     RETURNING id, created_at`,
    [operatorId ?? null, recommendationId, note, rec.tenant_id, rec.product_id],
  );

  logger.info({ recommendationId, operatorId }, 'Audit note added to advisor recommendation');

  const row = rows[0]!;
  return { id: row.id, created_at: row.created_at.toISOString() };
}

// ── getRecommendationHistory: last N weeks of recommendations ─────────────────

export async function getRecommendationHistory(
  productId: string,
  tenantId: string,
  weeks = 4,
): Promise<AdvisorRecommendation[]> {
  const pool = getPool();

  const { rows } = await pool.query<AdvisorRecommendation>(
    `SELECT id, product_id, tenant_id, recommendation_type, suggested_plan_id, rationale,
            confidence, status, week_start, projected_monthly_delta_cents, periods_analyzed,
            created_at, updated_at
     FROM advisor_recommendations
     WHERE product_id = $1 AND tenant_id = $2
       AND week_start >= CURRENT_DATE - ($3 * 7)
     ORDER BY week_start DESC`,
    [productId, tenantId, weeks],
  );

  return rows;
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

// ── listRecommendations (HUB-1699 E-BE-1 S22) ─────────────────────────────────
//
// Portfolio-wide flat list of recommendations with latest outcome + optional filters,
// powering HUB-1638 E-FE-4 S2 list view. Returns { data, total } so the FE table can
// paginate without N+1 fetches.
//
// Schema-vs-spec deviations (documented per ironclad-engineer Rule 14):
// - `currentPlan`, `churnRisk`, `operatorEmail` are NOT in the advisor schema — returned
//   as null. FE renders them when present or omits the field. Adding them is out of scope
//   for v0.1 (would require new columns + plan-assignment join + audit-log lookup).
// - `outcomeNote` ← advisor_outcomes.notes; `outcomeCapturedAt` ← advisor_outcomes.created_at
// - `recommendedPlan` ← pricing_models.model_type (no plan name column; model_type is the
//   closest semantic label HUB tracks).
// - Outcome filter: subquery joins to a per-recommendation latest outcome, then filters
//   via ANY() (per HUB-1697 OR-within-multi-value pattern).

export interface AdvisorRecommendationListRow {
  recommendationId: string;
  productId: string;
  tenantId: string;
  productName: string | null;
  currentPlan: null; // not in schema (see deviation note above)
  recommendedPlan: string | null;
  reasoning: string;
  mrrImpact: number | null;
  churnRisk: null; // not in schema
  outcome: OutcomeType | null;
  outcomeNote: string | null;
  createdAt: string;
  outcomeCapturedAt: string | null;
  operatorEmail: null; // not in schema
}

export interface ListRecommendationsOpts {
  productId?: string;
  outcomes?: OutcomeType[];
  limit?: number;
  offset?: number;
}

export interface ListRecommendationsResult {
  data: AdvisorRecommendationListRow[];
  total: number;
}

export async function listRecommendations(
  opts: ListRecommendationsOpts,
): Promise<ListRecommendationsResult> {
  const pool = getPool();
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (opts.productId) {
    conditions.push(`ar.product_id = $${idx++}`);
    params.push(opts.productId);
  }
  if (opts.outcomes && opts.outcomes.length > 0) {
    conditions.push(`latest_outcome.outcome_type = ANY($${idx++}::text[])`);
    params.push(opts.outcomes);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Subquery: latest outcome per recommendation (DISTINCT ON ordered by created_at DESC).
  // LEFT JOIN so recommendations without any outcome still appear (outcome = null).
  const baseFrom = `
    FROM advisor_recommendations ar
    LEFT JOIN products p ON p.id = ar.product_id
    LEFT JOIN pricing_models pm ON pm.id = ar.suggested_plan_id
    LEFT JOIN LATERAL (
      SELECT outcome_type, notes, created_at
        FROM advisor_outcomes ao
       WHERE ao.recommendation_id = ar.id
       ORDER BY ao.created_at DESC
       LIMIT 1
    ) latest_outcome ON true
  `;

  const { rows: countRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::bigint AS count ${baseFrom} ${where}`,
    params,
  );
  const total = parseInt(countRows[0]!.count, 10);

  const { rows } = await pool.query<{
    recommendation_id: string;
    product_id: string;
    tenant_id: string;
    product_name: string | null;
    recommended_plan: string | null;
    reasoning: string;
    mrr_impact: number | null;
    outcome: OutcomeType | null;
    outcome_note: string | null;
    created_at: Date;
    outcome_captured_at: Date | null;
  }>(
    `SELECT ar.id AS recommendation_id,
            ar.product_id, ar.tenant_id,
            p.name AS product_name,
            pm.model_type AS recommended_plan,
            ar.rationale AS reasoning,
            ar.projected_monthly_delta_cents AS mrr_impact,
            latest_outcome.outcome_type AS outcome,
            latest_outcome.notes AS outcome_note,
            ar.created_at,
            latest_outcome.created_at AS outcome_captured_at
       ${baseFrom}
       ${where}
   ORDER BY ar.created_at DESC
      LIMIT $${idx++} OFFSET $${idx}`,
    [...params, limit, offset],
  );

  return {
    total,
    data: rows.map((r) => ({
      recommendationId: r.recommendation_id,
      productId: r.product_id,
      tenantId: r.tenant_id,
      productName: r.product_name,
      currentPlan: null,
      recommendedPlan: r.recommended_plan,
      reasoning: r.reasoning,
      mrrImpact: r.mrr_impact,
      churnRisk: null,
      outcome: r.outcome,
      outcomeNote: r.outcome_note,
      createdAt: r.created_at.toISOString(),
      outcomeCapturedAt: r.outcome_captured_at ? r.outcome_captured_at.toISOString() : null,
      operatorEmail: null,
    })),
  };
}
