-- Authorized by HUB pricing Epics (E14–E20) — Dynamic Pricing & Plan Advisor
-- PK column is `id` throughout to match universal_delta_tracker() and HUB table conventions.
-- Route handlers expose `model_id`, `recommendation_id`, etc. in JSON by aliasing `id`.

CREATE TABLE pricing_models (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id      UUID        NOT NULL REFERENCES products(id),
  model_type      TEXT        NOT NULL CHECK (model_type IN ('flat_rate','tiered','usage_based','per_seat')),
  currency        TEXT        NOT NULL DEFAULT 'USD',
  config          JSONB       NOT NULL DEFAULT '{}',
  active          BOOLEAN     NOT NULL DEFAULT false,
  activated_at    TIMESTAMPTZ,
  deprecated_at   TIMESTAMPTZ,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data      JSONB
);

CREATE TABLE price_tiers (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id        UUID        NOT NULL REFERENCES pricing_models(id) ON DELETE CASCADE,
  tier_order      INTEGER     NOT NULL DEFAULT 0,
  up_to_units     INTEGER,
  unit_price_cents INTEGER    NOT NULL DEFAULT 0,
  flat_fee_cents  INTEGER     NOT NULL DEFAULT 0
);

CREATE TABLE plan_advisor_recommendations (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id                 UUID        NOT NULL REFERENCES products(id),
  tenant_id                  UUID        NOT NULL REFERENCES tenants(id),
  recommendation_type        TEXT        NOT NULL CHECK (recommendation_type IN ('upgrade','downgrade','annual','stay')),
  suggested_plan_id          TEXT,
  rationale                  TEXT        NOT NULL DEFAULT '',
  confidence                 TEXT        NOT NULL DEFAULT 'medium' CHECK (confidence IN ('low','medium','high')),
  projected_savings_cents    INTEGER,
  projected_cost_delta_cents INTEGER,
  week_start                 TEXT        NOT NULL,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE plan_change_ledger (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id      UUID        NOT NULL REFERENCES products(id),
  tenant_id       UUID        NOT NULL REFERENCES tenants(id),
  plan_id         TEXT        NOT NULL,
  effective_date  TEXT        NOT NULL,
  effective_at    TIMESTAMPTZ NOT NULL,
  audit_note      TEXT,
  discount_percent NUMERIC(5,2),
  price_overrides  JSONB       DEFAULT '{}',
  applied_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data      JSONB
);

-- Indexes
CREATE INDEX idx_pricing_models_product_active ON pricing_models(product_id, active);
CREATE INDEX idx_pricing_models_product_id     ON pricing_models(product_id);
CREATE INDEX idx_price_tiers_model_order       ON price_tiers(model_id, tier_order);
CREATE INDEX idx_plan_advisor_product_tenant   ON plan_advisor_recommendations(product_id, tenant_id, created_at DESC);
CREATE INDEX idx_plan_change_product_tenant    ON plan_change_ledger(product_id, tenant_id, created_at DESC);

-- Delta tracking (UPDATE + DELETE audit trail)
CREATE TRIGGER track_delta_pricing_models
  BEFORE UPDATE OR DELETE ON pricing_models
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

CREATE TRIGGER track_delta_plan_change_ledger
  BEFORE UPDATE OR DELETE ON plan_change_ledger
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();
