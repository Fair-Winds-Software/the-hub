-- Authorized by HUB-1147 — tenant_plan_assignments, tenant_discounts, tenant_pricing_overrides, operator_audit_log

-- ── Enum types ────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE effective_date_type AS ENUM ('immediate', 'next_billing_cycle', 'custom');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE discount_type AS ENUM ('percentage', 'fixed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── tenant_plan_assignments ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tenant_plan_assignments (
  id                   UUID                 PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID                 NOT NULL REFERENCES tenants(id),
  product_id           UUID                 NOT NULL REFERENCES products(id),
  pricing_model_id     UUID                 NOT NULL REFERENCES pricing_models(id),
  effective_date_type  effective_date_type  NOT NULL DEFAULT 'immediate',
  effective_date       TIMESTAMPTZ,
  assigned_by          UUID                 REFERENCES operator_accounts(id),
  notes                TEXT,
  active               BOOLEAN              NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ          NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ          NOT NULL DEFAULT NOW(),
  delta_data           JSONB
);

CREATE INDEX IF NOT EXISTS idx_tenant_plan_assignments_tenant_product
  ON tenant_plan_assignments(tenant_id, product_id);
CREATE INDEX IF NOT EXISTS idx_tenant_plan_assignments_active
  ON tenant_plan_assignments(active) WHERE active = true;

CREATE OR REPLACE TRIGGER trg_tenant_plan_assignments_delta
  BEFORE UPDATE ON tenant_plan_assignments
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

-- ── tenant_discounts ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tenant_discounts (
  id                   UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID          NOT NULL REFERENCES tenants(id),
  product_id           UUID          NOT NULL REFERENCES products(id),
  discount_type        discount_type NOT NULL,
  discount_value       NUMERIC(10,4) NOT NULL CHECK (discount_value > 0),
  expiry_date          TIMESTAMPTZ,
  notes                TEXT,
  applied_by           UUID          REFERENCES operator_accounts(id),
  active               BOOLEAN       NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  delta_data           JSONB
);

CREATE INDEX IF NOT EXISTS idx_tenant_discounts_tenant_product
  ON tenant_discounts(tenant_id, product_id);
CREATE INDEX IF NOT EXISTS idx_tenant_discounts_active
  ON tenant_discounts(active) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_tenant_discounts_expiry
  ON tenant_discounts(expiry_date) WHERE expiry_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tenant_discounts_long_running
  ON tenant_discounts(created_at) WHERE active = true;

CREATE OR REPLACE TRIGGER trg_tenant_discounts_delta
  BEFORE UPDATE ON tenant_discounts
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

-- ── tenant_pricing_overrides ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tenant_pricing_overrides (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID        NOT NULL REFERENCES tenants(id),
  product_id           UUID        NOT NULL REFERENCES products(id),
  metric_name          TEXT        NOT NULL,
  unit_price_cents     INTEGER     NOT NULL CHECK (unit_price_cents >= 0),
  applied_by           UUID        REFERENCES operator_accounts(id),
  active               BOOLEAN     NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data           JSONB,
  CONSTRAINT uq_tenant_product_metric UNIQUE (tenant_id, product_id, metric_name)
);

CREATE INDEX IF NOT EXISTS idx_tenant_pricing_overrides_tenant_product
  ON tenant_pricing_overrides(tenant_id, product_id);

CREATE OR REPLACE TRIGGER trg_tenant_pricing_overrides_delta
  BEFORE UPDATE ON tenant_pricing_overrides
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

-- ── operator_audit_log ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS operator_audit_log (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id          UUID        REFERENCES operator_accounts(id),
  entity_type          TEXT        NOT NULL,
  entity_id            TEXT        NOT NULL,
  action               TEXT        NOT NULL,
  before_value         JSONB,
  after_value          JSONB,
  notes                TEXT,
  tenant_id            UUID        REFERENCES tenants(id),
  product_id           UUID        REFERENCES products(id),
  recommendation_id    UUID        REFERENCES advisor_recommendations(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_operator_audit_log_tenant
  ON operator_audit_log(tenant_id) WHERE tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_operator_audit_log_product
  ON operator_audit_log(product_id) WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_operator_audit_log_entity
  ON operator_audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_operator_audit_log_created
  ON operator_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_operator_audit_log_recommendation
  ON operator_audit_log(recommendation_id) WHERE recommendation_id IS NOT NULL;
