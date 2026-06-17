-- Authorized by HUB-1031 — compliance_evaluation_runs + compliance_current_verdicts schemas
-- Authorized by HUB-1036 — compliance_verdict_history (immutable) + compliance_posture_scores schemas

-- ── compliance_evaluation_runs: evaluation run tracking ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS compliance_evaluation_runs (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at        TIMESTAMPTZ,
  status              TEXT        NOT NULL DEFAULT 'running'
                                  CHECK (status IN ('running', 'completed', 'failed')),
  products_evaluated  INT         NOT NULL DEFAULT 0,
  controls_evaluated  INT         NOT NULL DEFAULT 0,
  controls_passed     INT         NOT NULL DEFAULT 0,
  controls_failed     INT         NOT NULL DEFAULT 0,
  controls_overdue    INT         NOT NULL DEFAULT 0,
  controls_observe    INT         NOT NULL DEFAULT 0,
  error_message       TEXT,
  delta_data          JSONB
);
CREATE INDEX IF NOT EXISTS idx_compliance_eval_runs_status ON compliance_evaluation_runs(status);
CREATE INDEX IF NOT EXISTS idx_compliance_eval_runs_started ON compliance_evaluation_runs(started_at DESC);

CREATE TRIGGER track_delta_compliance_evaluation_runs
  BEFORE UPDATE OR DELETE ON compliance_evaluation_runs
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

-- ── compliance_current_verdicts: per-product/control current state ────────────────────────────────
CREATE TABLE IF NOT EXISTS compliance_current_verdicts (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id         UUID        NOT NULL REFERENCES products(id),
  control_id         UUID        NOT NULL REFERENCES compliance_controls(id),
  verdict            TEXT        NOT NULL CHECK (verdict IN ('pass', 'fail', 'overdue', 'observe')),
  evaluated_at       TIMESTAMPTZ NOT NULL,
  evaluation_run_id  UUID        NOT NULL REFERENCES compliance_evaluation_runs(id),
  signal_id          TEXT,
  delta_data         JSONB,
  CONSTRAINT compliance_current_verdicts_uq UNIQUE (product_id, control_id)
);
CREATE INDEX IF NOT EXISTS idx_compliance_current_verdicts_product ON compliance_current_verdicts(product_id);
CREATE INDEX IF NOT EXISTS idx_compliance_current_verdicts_verdict ON compliance_current_verdicts(verdict);

CREATE TRIGGER track_delta_compliance_current_verdicts
  BEFORE UPDATE OR DELETE ON compliance_current_verdicts
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

-- ── compliance_verdict_history: immutable append-only verdict log ─────────────────────────────────
-- No UPDATE or DELETE permitted (no delta_data column).
CREATE TABLE IF NOT EXISTS compliance_verdict_history (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id         UUID        NOT NULL REFERENCES products(id),
  control_id         UUID        NOT NULL REFERENCES compliance_controls(id),
  verdict            TEXT        NOT NULL CHECK (verdict IN ('pass', 'fail', 'overdue', 'observe')),
  evaluated_at       TIMESTAMPTZ NOT NULL,
  evaluation_run_id  UUID        NOT NULL REFERENCES compliance_evaluation_runs(id),
  signal_id          TEXT
);
CREATE INDEX IF NOT EXISTS idx_compliance_verdict_history_product ON compliance_verdict_history(product_id, control_id);
CREATE INDEX IF NOT EXISTS idx_compliance_verdict_history_evaluated ON compliance_verdict_history(evaluated_at DESC);

-- ── compliance_posture_scores: precomputed per-product per-TSC-category scores ───────────────────
CREATE TABLE IF NOT EXISTS compliance_posture_scores (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id        UUID        NOT NULL REFERENCES products(id),
  tsc_category      TEXT        NOT NULL,
  score_pct         NUMERIC(5,2) NOT NULL CHECK (score_pct >= 0 AND score_pct <= 100),
  controls_total    INT         NOT NULL DEFAULT 0,
  controls_passed   INT         NOT NULL DEFAULT 0,
  controls_failed   INT         NOT NULL DEFAULT 0,
  controls_overdue  INT         NOT NULL DEFAULT 0,
  controls_observe  INT         NOT NULL DEFAULT 0,
  computed_at       TIMESTAMPTZ NOT NULL,
  delta_data        JSONB,
  CONSTRAINT compliance_posture_scores_uq UNIQUE (product_id, tsc_category)
);
CREATE INDEX IF NOT EXISTS idx_compliance_posture_scores_product ON compliance_posture_scores(product_id);

CREATE TRIGGER track_delta_compliance_posture_scores
  BEFORE UPDATE OR DELETE ON compliance_posture_scores
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();
