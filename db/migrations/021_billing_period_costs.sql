-- Authorized by HUB-664 — billing_period_costs table; pre-aggregated cost summaries per billing period

CREATE TABLE IF NOT EXISTS billing_period_costs (
  tenant_id        UUID        NOT NULL REFERENCES tenants(id),
  product_id       UUID        NOT NULL REFERENCES products(id),
  period_start     TIMESTAMPTZ NOT NULL,
  period_end       TIMESTAMPTZ NOT NULL,
  total_units      INTEGER     NOT NULL CHECK (total_units >= 0),
  total_cost_cents INTEGER     NOT NULL CHECK (total_cost_cents >= 0),
  event_count      INTEGER     NOT NULL CHECK (event_count >= 0),
  late_event_count INTEGER     NOT NULL CHECK (late_event_count >= 0),
  aggregated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data       JSONB,
  CONSTRAINT billing_period_costs_pkey UNIQUE (tenant_id, product_id, period_start)
);

CREATE INDEX IF NOT EXISTS billing_period_costs_lookup_idx
  ON billing_period_costs (tenant_id, product_id, period_start);

CREATE TRIGGER track_delta_billing_period_costs
  BEFORE UPDATE OR DELETE ON billing_period_costs
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

-- Rollback:
-- DROP TRIGGER IF EXISTS track_delta_billing_period_costs ON billing_period_costs;
-- DROP INDEX IF EXISTS billing_period_costs_lookup_idx;
-- DROP TABLE IF EXISTS billing_period_costs;
