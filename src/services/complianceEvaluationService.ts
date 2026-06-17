// Authorized by HUB-1043 — automated control evaluator: daily CRON, cadence-window signal lookup, pass/fail verdicts
// Authorized by HUB-1048 — human control evaluator, posture score aggregation, current/history query helpers
import type { Pool } from 'pg';
import { getPool } from '../db/pool.js';

type Verdict = 'pass' | 'fail' | 'overdue' | 'observe';

// Cadence window in milliseconds — used to compute the cutoff timestamp as a JS Date parameter
const CADENCE_MS: Record<string, number> = {
  daily: 24 * 60 * 60 * 1_000,
  weekly: 7 * 24 * 60 * 60 * 1_000,
  monthly: 30 * 24 * 60 * 60 * 1_000,
  continuous: 24 * 60 * 60 * 1_000,
};

export async function runComplianceEvaluation(): Promise<{
  productsEvaluated: number;
  controlsEvaluated: number;
  verdicts: Record<Verdict, number>;
}> {
  const pool = getPool();

  const { rows: runRows } = await pool.query<{ id: string }>(
    `INSERT INTO compliance_evaluation_runs (status) VALUES ('running') RETURNING id`,
  );
  const runId = runRows[0]!.id;

  try {
    const result = await _evaluate(pool, runId);
    await pool.query(
      `UPDATE compliance_evaluation_runs
       SET status = 'completed', completed_at = NOW(),
           products_evaluated = $2, controls_evaluated = $3,
           controls_passed = $4, controls_failed = $5,
           controls_overdue = $6, controls_observe = $7
       WHERE id = $1`,
      [
        runId,
        result.productsEvaluated,
        result.controlsEvaluated,
        result.verdicts.pass,
        result.verdicts.fail,
        result.verdicts.overdue,
        result.verdicts.observe,
      ],
    );
    await _computePostureScores(pool);
    return result;
  } catch (err) {
    await pool.query(
      `UPDATE compliance_evaluation_runs
       SET status = 'failed', completed_at = NOW(), error_message = $2
       WHERE id = $1`,
      [runId, (err as Error).message],
    );
    throw err;
  }
}

async function _evaluate(
  pool: Pool,
  runId: string,
): Promise<{ productsEvaluated: number; controlsEvaluated: number; verdicts: Record<Verdict, number> }> {
  const { rows: registrations } = await pool.query<{
    product_id: string;
    burn_in_state: string;
  }>(
    `SELECT product_id, burn_in_state FROM compliance_product_registrations WHERE active = true`,
  );

  let totalControls = 0;
  const counts: Record<Verdict, number> = { pass: 0, fail: 0, overdue: 0, observe: 0 };

  for (const reg of registrations) {
    const { rows: bindings } = await pool.query<{
      control_id: string;
      control_class: 'automated' | 'human';
      eval_cadence: string;
    }>(
      `SELECT b.control_id, c.control_class, c.eval_cadence
       FROM product_control_bindings b
       JOIN compliance_controls c ON c.id = b.control_id
       WHERE b.product_id = $1 AND b.active = true AND c.active = true`,
      [reg.product_id],
    );

    const evaluatedAt = new Date();

    for (const binding of bindings) {
      let verdict: Verdict;
      let signalId: string | null = null;

      if (reg.burn_in_state !== 'enforced') {
        verdict = 'observe';
      } else {
        const cutoff = new Date(Date.now() - (CADENCE_MS[binding.eval_cadence] ?? CADENCE_MS.daily));
        const { rows: signalRows } = await pool.query<{ signal_id: string }>(
          `SELECT signal_id FROM compliance_signal_evidence
           WHERE product_id = $1 AND control_id = $2
             AND observed_at >= $3
             AND is_burn_in_gap = false
           ORDER BY observed_at DESC
           LIMIT 1`,
          [reg.product_id, binding.control_id, cutoff],
        );

        if (signalRows.length > 0) {
          verdict = 'pass';
          signalId = signalRows[0]!.signal_id;
        } else {
          verdict = binding.control_class === 'human' ? 'overdue' : 'fail';
        }
      }

      await pool.query(
        `INSERT INTO compliance_current_verdicts
           (product_id, control_id, verdict, evaluated_at, evaluation_run_id, signal_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (product_id, control_id) DO UPDATE
         SET verdict = EXCLUDED.verdict,
             evaluated_at = EXCLUDED.evaluated_at,
             evaluation_run_id = EXCLUDED.evaluation_run_id,
             signal_id = EXCLUDED.signal_id`,
        [reg.product_id, binding.control_id, verdict, evaluatedAt, runId, signalId],
      );

      await pool.query(
        `INSERT INTO compliance_verdict_history
           (product_id, control_id, verdict, evaluated_at, evaluation_run_id, signal_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [reg.product_id, binding.control_id, verdict, evaluatedAt, runId, signalId],
      );

      counts[verdict]++;
      totalControls++;
    }
  }

  return {
    productsEvaluated: registrations.length,
    controlsEvaluated: totalControls,
    verdicts: counts,
  };
}

async function _computePostureScores(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{
    product_id: string;
    tsc_category: string;
    controls_total: string;
    controls_passed: string;
    controls_failed: string;
    controls_overdue: string;
    controls_observe: string;
  }>(
    `SELECT cv.product_id, c.tsc_category,
            COUNT(*)                                            AS controls_total,
            COUNT(*) FILTER (WHERE cv.verdict = 'pass')        AS controls_passed,
            COUNT(*) FILTER (WHERE cv.verdict = 'fail')        AS controls_failed,
            COUNT(*) FILTER (WHERE cv.verdict = 'overdue')     AS controls_overdue,
            COUNT(*) FILTER (WHERE cv.verdict = 'observe')     AS controls_observe
     FROM compliance_current_verdicts cv
     JOIN compliance_controls c ON c.id = cv.control_id
     GROUP BY cv.product_id, c.tsc_category`,
  );

  for (const row of rows) {
    const total = parseInt(row.controls_total, 10);
    const passed = parseInt(row.controls_passed, 10);
    const scorePct = total > 0 ? ((passed / total) * 100).toFixed(2) : '0.00';

    await pool.query(
      `INSERT INTO compliance_posture_scores
         (product_id, tsc_category, score_pct, controls_total, controls_passed,
          controls_failed, controls_overdue, controls_observe, computed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (product_id, tsc_category) DO UPDATE
       SET score_pct = EXCLUDED.score_pct,
           controls_total = EXCLUDED.controls_total,
           controls_passed = EXCLUDED.controls_passed,
           controls_failed = EXCLUDED.controls_failed,
           controls_overdue = EXCLUDED.controls_overdue,
           controls_observe = EXCLUDED.controls_observe,
           computed_at = EXCLUDED.computed_at`,
      [
        row.product_id,
        row.tsc_category,
        scorePct,
        total,
        passed,
        parseInt(row.controls_failed, 10),
        parseInt(row.controls_overdue, 10),
        parseInt(row.controls_observe, 10),
      ],
    );
  }
}

// ── Query helpers (HUB-1048) ─────────────────────────────────────────────────

export async function getProductPosture(productId: string): Promise<{
  product_id: string;
  overall_score_pct: number;
  categories: Array<{
    tsc_category: string;
    score_pct: number;
    controls_total: number;
    controls_passed: number;
    controls_failed: number;
    controls_overdue: number;
    controls_observe: number;
    computed_at: Date;
  }>;
}> {
  const pool = getPool();
  const { rows } = await pool.query<{
    tsc_category: string;
    score_pct: string;
    controls_total: number;
    controls_passed: number;
    controls_failed: number;
    controls_overdue: number;
    controls_observe: number;
    computed_at: Date;
  }>(
    `SELECT tsc_category, score_pct, controls_total, controls_passed,
            controls_failed, controls_overdue, controls_observe, computed_at
     FROM compliance_posture_scores
     WHERE product_id = $1
     ORDER BY tsc_category ASC`,
    [productId],
  );

  const totalControls = rows.reduce((s, r) => s + r.controls_total, 0);
  const totalPassed = rows.reduce((s, r) => s + r.controls_passed, 0);
  const overallScore = totalControls > 0 ? parseFloat(((totalPassed / totalControls) * 100).toFixed(2)) : 0;

  return {
    product_id: productId,
    overall_score_pct: overallScore,
    categories: rows.map((r) => ({ ...r, score_pct: parseFloat(r.score_pct) })),
  };
}

export async function getProductCurrentVerdicts(productId: string): Promise<
  Array<{
    control_id: string;
    control_key: string;
    control_name: string;
    tsc_category: string;
    control_class: string;
    verdict: string;
    evaluated_at: Date;
    signal_id: string | null;
  }>
> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT cv.control_id, c.control_id AS control_key, c.name AS control_name,
            c.tsc_category, c.control_class, cv.verdict, cv.evaluated_at, cv.signal_id
     FROM compliance_current_verdicts cv
     JOIN compliance_controls c ON c.id = cv.control_id
     WHERE cv.product_id = $1
     ORDER BY c.tsc_category ASC, c.control_id ASC`,
    [productId],
  );
  return rows as typeof rows;
}

export async function getProductVerdictHistory(
  productId: string,
  limit: number,
  offset: number,
): Promise<{ history: unknown[]; total: number }> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT vh.id, vh.control_id, c.control_id AS control_key, c.name AS control_name,
            c.tsc_category, vh.verdict, vh.evaluated_at, vh.signal_id, vh.evaluation_run_id,
            COUNT(*) OVER() AS total_count
     FROM compliance_verdict_history vh
     JOIN compliance_controls c ON c.id = vh.control_id
     WHERE vh.product_id = $1
     ORDER BY vh.evaluated_at DESC
     LIMIT $2 OFFSET $3`,
    [productId, limit, offset],
  );

  const total = rows.length > 0 ? parseInt((rows[0] as { total_count: string }).total_count, 10) : 0;
  const history = rows.map(({ total_count: _tc, ...rest }) => rest);
  return { history, total };
}
