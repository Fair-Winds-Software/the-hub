-- Authorized by HUB-1741 (E-V2-PP-3 S1, HUB-1727, HUB-1701) — plan_metered_dimensions
-- table. Declares which dimensions a plan meters (Synapz shape: rules /
-- business_users / evaluations / symbolic_ops — 4 dimensions per plan is common).
--
-- Per D-HUB-1701-03 (Reconciliation Log 2026-07-07), per-tier overage rates
-- themselves live inside plans.tiers JSONB (extended shape:
-- [{upTo, unitAmount, overage_rates: [{dimension_key, included_quantity, rate_per_unit_cents}]}])
-- — no separate plan_tier_overage_rates table. HUB-1742 (S2) is therefore a
-- service-layer story, not a schema story.

CREATE TABLE IF NOT EXISTS plan_metered_dimensions (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id          UUID        NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  dimension_key    TEXT        NOT NULL
                               CHECK (dimension_key ~ '^[a-z][a-z0-9_]{2,63}$'),
  dimension_label  TEXT        NOT NULL,
  sort_order       INTEGER     NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data       JSONB,
  CONSTRAINT plan_metered_dimensions_uq UNIQUE (plan_id, dimension_key)
);

CREATE INDEX IF NOT EXISTS idx_plan_metered_dimensions_plan
  ON plan_metered_dimensions(plan_id, sort_order);

CREATE TRIGGER plan_metered_dimensions_delta_tracker
  BEFORE UPDATE OR DELETE ON plan_metered_dimensions
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();
