-- Authorized by HUB-636 — margin_configs and margin_evaluations tables; D-001 alert-only invariant

CREATE TABLE IF NOT EXISTS margin_configs (
  id                          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id                  UUID          NOT NULL UNIQUE REFERENCES products(id) ON DELETE CASCADE,
  floor_percentage            DECIMAL(5,2)  NOT NULL,
  alert_threshold_percentage  DECIMAL(5,2)  NOT NULL,
  enabled                     BOOLEAN       NOT NULL DEFAULT true,
  created_by                  VARCHAR(255),
  delta_data                  JSONB,
  created_at                  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CHECK (floor_percentage >= 0 AND floor_percentage <= 100),
  CHECK (alert_threshold_percentage >= 0 AND alert_threshold_percentage <= 100)
);

CREATE TABLE IF NOT EXISTS margin_evaluations (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID          NOT NULL REFERENCES tenants(id),
  product_id        UUID          NOT NULL REFERENCES products(id),
  evaluated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  revenue_cents     INTEGER       NOT NULL CHECK (revenue_cents >= 0),
  cost_cents        INTEGER       NOT NULL CHECK (cost_cents >= 0),
  margin_percentage DECIMAL(5,2)  NOT NULL,
  below_floor       BOOLEAN       NOT NULL,
  delta_data        JSONB
  -- D-001: no suspended/blocked/action_taken columns — margin floor is alert-only; never blocks
);

CREATE INDEX IF NOT EXISTS margin_evaluations_tenant_product_time_idx
  ON margin_evaluations (tenant_id, product_id, evaluated_at DESC NULLS LAST);

CREATE TRIGGER margin_configs_updated_at
  BEFORE UPDATE ON margin_configs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER track_delta_margin_configs
  BEFORE UPDATE OR DELETE ON margin_configs
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

CREATE TRIGGER track_delta_margin_evaluations
  BEFORE UPDATE OR DELETE ON margin_evaluations
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();
