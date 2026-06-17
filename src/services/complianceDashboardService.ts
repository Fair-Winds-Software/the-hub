// Authorized by HUB-1057 — compliance dashboard helpers: ragStatus, tscPrefix, overview/detail/trend queries
// Authorized by HUB-1062 — getDashboardOverview: platform-level readiness aggregation
// Authorized by HUB-1065 — getProductDashboardDetail: per-product control detail view
// Authorized by HUB-1069 — getProductTrend: 30/60/90-day posture trend reconstruction from verdict history
import { getPool } from '../db/pool.js';

type RagStatus = 'green' | 'amber' | 'red';

export function ragStatus(scorePct: number): RagStatus {
  if (scorePct >= 90) return 'green';
  if (scorePct >= 70) return 'amber';
  return 'red';
}

export function tscPrefix(category: string): string {
  if (category === 'OVERALL') return 'OVERALL';
  // CC categories: CC6.1 → CC6, CC7 → CC7
  const ccMatch = category.match(/^(CC\d+)/);
  if (ccMatch) return ccMatch[1]!;
  // Non-CC single or multi-letter categories: A1 → A, C1 → C, PI1 → PI
  const letterPrefix = category.match(/^([A-Z]+)/);
  return letterPrefix ? letterPrefix[1]! : category;
}

interface CategorySummary {
  tsc_category: string;
  score_pct: number;
  rag_status: RagStatus;
}

interface ProductSummary {
  product_id: string;
  product_name: string;
  overall_score_pct: number;
  rag_status: RagStatus;
  categories: CategorySummary[];
}

export interface DashboardOverview {
  overall_score_pct: number;
  rag_status: RagStatus;
  total_products: number;
  products: ProductSummary[];
}

export async function getDashboardOverview(tenantId: string | null): Promise<DashboardOverview> {
  const pool = getPool();

  const { rows } = await pool.query<{
    product_id: string;
    product_name: string;
    tsc_category: string;
    score_pct: string;
    controls_total: number;
    controls_passed: number;
  }>(
    `SELECT p.id AS product_id, p.name AS product_name,
            ps.tsc_category, ps.score_pct, ps.controls_total, ps.controls_passed
     FROM products p
     JOIN compliance_product_registrations cpr ON cpr.product_id = p.id AND cpr.active = true
     JOIN compliance_posture_scores ps ON ps.product_id = p.id
     WHERE p.active = true
       AND ($1::uuid IS NULL OR p.tenant_id = $1::uuid)
     ORDER BY p.name ASC, ps.tsc_category ASC`,
    [tenantId],
  );

  // Group rows by product
  const productMap = new Map<string, {
    product_id: string;
    product_name: string;
    categories: { tsc_category: string; score_pct: number; controls_total: number; controls_passed: number }[];
  }>();

  for (const row of rows) {
    let entry = productMap.get(row.product_id);
    if (!entry) {
      entry = { product_id: row.product_id, product_name: row.product_name, categories: [] };
      productMap.set(row.product_id, entry);
    }
    entry.categories.push({
      tsc_category: row.tsc_category,
      score_pct: parseFloat(row.score_pct),
      controls_total: row.controls_total,
      controls_passed: row.controls_passed,
    });
  }

  let platformTotal = 0;
  let platformPassed = 0;

  const products: ProductSummary[] = [];
  for (const p of productMap.values()) {
    const totalControls = p.categories.reduce((s, c) => s + c.controls_total, 0);
    const totalPassed = p.categories.reduce((s, c) => s + c.controls_passed, 0);
    const overallScore = totalControls > 0 ? parseFloat(((totalPassed / totalControls) * 100).toFixed(2)) : 0;
    platformTotal += totalControls;
    platformPassed += totalPassed;
    products.push({
      product_id: p.product_id,
      product_name: p.product_name,
      overall_score_pct: overallScore,
      rag_status: ragStatus(overallScore),
      categories: p.categories.map((c) => ({
        tsc_category: c.tsc_category,
        score_pct: c.score_pct,
        rag_status: ragStatus(c.score_pct),
      })),
    });
  }

  const platformScore = platformTotal > 0 ? parseFloat(((platformPassed / platformTotal) * 100).toFixed(2)) : 0;

  return {
    overall_score_pct: platformScore,
    rag_status: ragStatus(platformScore),
    total_products: products.length,
    products,
  };
}

interface ControlDetail {
  control_key: string;
  control_name: string;
  verdict: string;
  last_signal_at: string | null;
}

interface DetailCategory {
  tsc_category: string;
  score_pct: number;
  rag_status: RagStatus;
  controls: ControlDetail[];
}

export interface ProductDashboardDetail {
  product_id: string;
  product_name: string;
  overall_score_pct: number;
  rag_status: RagStatus;
  categories: DetailCategory[];
}

export async function getProductDashboardDetail(productId: string): Promise<ProductDashboardDetail> {
  const pool = getPool();

  const { rows: productRows } = await pool.query<{ name: string }>(
    `SELECT name FROM products WHERE id = $1 AND active = true`,
    [productId],
  );
  const productName = productRows[0]?.name ?? '';

  const { rows: postureRows } = await pool.query<{
    tsc_category: string;
    score_pct: string;
    controls_total: number;
    controls_passed: number;
  }>(
    `SELECT tsc_category, score_pct, controls_total, controls_passed
     FROM compliance_posture_scores WHERE product_id = $1 ORDER BY tsc_category ASC`,
    [productId],
  );

  const { rows: controlRows } = await pool.query<{
    control_key: string;
    control_name: string;
    tsc_category: string;
    verdict: string;
    signal_id: string | null;
    last_signal_at: Date | null;
  }>(
    `SELECT c.control_id AS control_key, c.name AS control_name, c.tsc_category,
            cv.verdict, cv.signal_id,
            se.observed_at AS last_signal_at
     FROM compliance_current_verdicts cv
     JOIN compliance_controls c ON c.id = cv.control_id
     LEFT JOIN compliance_signal_evidence se
       ON se.product_id = cv.product_id AND se.signal_id = cv.signal_id
     WHERE cv.product_id = $1
     ORDER BY c.tsc_category ASC, c.control_id ASC`,
    [productId],
  );

  // Build category map
  const categoryPosture = new Map<string, { score_pct: number; controls_total: number; controls_passed: number }>();
  for (const r of postureRows) {
    categoryPosture.set(r.tsc_category, {
      score_pct: parseFloat(r.score_pct),
      controls_total: r.controls_total,
      controls_passed: r.controls_passed,
    });
  }

  const categoryControlMap = new Map<string, ControlDetail[]>();
  for (const r of controlRows) {
    const cat = r.tsc_category;
    if (!categoryControlMap.has(cat)) categoryControlMap.set(cat, []);
    categoryControlMap.get(cat)!.push({
      control_key: r.control_key,
      control_name: r.control_name,
      verdict: r.verdict,
      last_signal_at: r.last_signal_at ? r.last_signal_at.toISOString() : null,
    });
  }

  const totalControls = postureRows.reduce((s, r) => s + r.controls_total, 0);
  const totalPassed = postureRows.reduce((s, r) => s + r.controls_passed, 0);
  const overallScore = totalControls > 0 ? parseFloat(((totalPassed / totalControls) * 100).toFixed(2)) : 0;

  const categories: DetailCategory[] = Array.from(categoryPosture.entries()).map(([cat, posture]) => ({
    tsc_category: cat,
    score_pct: posture.score_pct,
    rag_status: ragStatus(posture.score_pct),
    controls: categoryControlMap.get(cat) ?? [],
  }));

  return {
    product_id: productId,
    product_name: productName,
    overall_score_pct: overallScore,
    rag_status: ragStatus(overallScore),
    categories,
  };
}

interface TrendDatapoint {
  date: string;
  score_pct: number;
  rag_status: RagStatus;
}

export interface ProductTrendResponse {
  product_id: string;
  window: 30 | 60 | 90;
  datapoints: TrendDatapoint[];
}

export async function getProductTrend(productId: string, window: 30 | 60 | 90): Promise<ProductTrendResponse> {
  const pool = getPool();
  const since = new Date(Date.now() - window * 24 * 60 * 60 * 1_000);

  // DISTINCT ON CTE: for each (day, control_id) take the latest verdict in that day.
  // Then aggregate per-day pass count to reconstruct posture score.
  const { rows } = await pool.query<{ date: string; score_pct: string }>(
    `WITH daily_verdicts AS (
       SELECT DISTINCT ON (DATE_TRUNC('day', evaluated_at AT TIME ZONE 'UTC'), control_id)
         DATE_TRUNC('day', evaluated_at AT TIME ZONE 'UTC') AS day,
         control_id,
         verdict
       FROM compliance_verdict_history
       WHERE product_id = $1
         AND evaluated_at >= $2
       ORDER BY DATE_TRUNC('day', evaluated_at AT TIME ZONE 'UTC'), control_id, evaluated_at DESC
     ),
     daily_scores AS (
       SELECT day,
              COUNT(*)                                       AS total,
              COUNT(*) FILTER (WHERE verdict = 'pass')      AS passed
       FROM daily_verdicts
       GROUP BY day
     )
     SELECT TO_CHAR(day, 'YYYY-MM-DD') AS date,
            CASE WHEN total > 0 THEN ROUND((passed::numeric / total::numeric) * 100, 2) ELSE 0::numeric END AS score_pct
     FROM daily_scores
     ORDER BY day ASC`,
    [productId, since],
  );

  return {
    product_id: productId,
    window,
    datapoints: rows.map((r) => {
      const score = parseFloat(r.score_pct);
      return { date: r.date, score_pct: score, rag_status: ragStatus(score) };
    }),
  };
}
