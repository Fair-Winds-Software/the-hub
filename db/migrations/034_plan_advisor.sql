-- Authorized by HUB-1141 — advisor_recommendations + advisor_outcomes schema with delta tracking

-- ── Enum types ──────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE advisor_recommendation_type AS ENUM ('upgrade', 'downgrade', 'switch_to_annual', 'stay');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE advisor_confidence AS ENUM ('high', 'medium', 'low');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE advisor_recommendation_status AS ENUM ('open', 'applied', 'dismissed', 'superseded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE advisor_outcome_type AS ENUM ('applied', 'dismissed', 'auto_detected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── advisor_recommendations ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS advisor_recommendations (
  id                           UUID                          PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id                   UUID                          NOT NULL REFERENCES products(id),
  tenant_id                    UUID                          NOT NULL REFERENCES tenants(id),
  recommendation_type          advisor_recommendation_type   NOT NULL,
  suggested_plan_id            UUID                          REFERENCES pricing_models(model_id),
  rationale                    TEXT                          NOT NULL,
  confidence                   advisor_confidence            NOT NULL,
  status                       advisor_recommendation_status NOT NULL DEFAULT 'open',
  week_start                   DATE                          NOT NULL,
  projected_monthly_delta_cents INT,
  periods_analyzed             INT                           NOT NULL DEFAULT 0,
  created_at                   TIMESTAMPTZ                   NOT NULL DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ                   NOT NULL DEFAULT NOW(),
  delta_data                   JSONB,

  -- One recommendation per (product, tenant) per week; upserted by advisor engine
  CONSTRAINT uq_advisor_rec_product_tenant_week UNIQUE (product_id, tenant_id, week_start)
);

CREATE INDEX IF NOT EXISTS idx_advisor_recs_product_tenant
  ON advisor_recommendations(product_id, tenant_id);
CREATE INDEX IF NOT EXISTS idx_advisor_recs_status
  ON advisor_recommendations(status);
CREATE INDEX IF NOT EXISTS idx_advisor_recs_week_start
  ON advisor_recommendations(week_start DESC);

CREATE OR REPLACE TRIGGER trg_advisor_recommendations_delta
  BEFORE UPDATE ON advisor_recommendations
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

-- ── advisor_outcomes ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS advisor_outcomes (
  id                UUID                  PRIMARY KEY DEFAULT gen_random_uuid(),
  recommendation_id UUID                  NOT NULL REFERENCES advisor_recommendations(id) ON DELETE CASCADE,
  check_date        DATE                  NOT NULL DEFAULT CURRENT_DATE,
  outcome_type      advisor_outcome_type  NOT NULL,
  outcome_value     JSONB,
  notes             TEXT,
  created_at        TIMESTAMPTZ           NOT NULL DEFAULT NOW(),
  delta_data        JSONB
);

CREATE INDEX IF NOT EXISTS idx_advisor_outcomes_recommendation
  ON advisor_outcomes(recommendation_id);
CREATE INDEX IF NOT EXISTS idx_advisor_outcomes_check_date
  ON advisor_outcomes(check_date DESC);

CREATE OR REPLACE TRIGGER trg_advisor_outcomes_delta
  BEFORE UPDATE ON advisor_outcomes
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();
