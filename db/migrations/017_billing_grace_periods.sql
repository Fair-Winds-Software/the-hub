-- Authorized by HUB-496 — billing_grace_periods table; open/resolved state derived from resolved_at IS NULL
CREATE TABLE IF NOT EXISTS billing_grace_periods (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id          UUID          NOT NULL,
  started_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ   NOT NULL,  -- value supplied by caller; no DEFAULT; D-DEF-001 deferred
  reason              VARCHAR(255)  NOT NULL,
  resolved_at         TIMESTAMPTZ,
  resolution          VARCHAR(50),             -- 'reactivated' | 'cancelled' | 'expired'
  delta_data          JSONB,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT billing_grace_periods_resolution_consistent
    CHECK (
      (resolved_at IS NULL AND resolution IS NULL) OR
      (resolved_at IS NOT NULL AND resolution IS NOT NULL)
    )
);
CREATE INDEX IF NOT EXISTS billing_grace_periods_tenant_product_idx
  ON billing_grace_periods (tenant_id, product_id);
-- Partial index scopes all open-period lookups to unresolved rows only
CREATE INDEX IF NOT EXISTS billing_grace_periods_open_idx
  ON billing_grace_periods (tenant_id, product_id)
  WHERE resolved_at IS NULL;
CREATE TRIGGER billing_grace_periods_updated_at
  BEFORE UPDATE ON billing_grace_periods
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER billing_grace_periods_delta_tracker
  BEFORE UPDATE OR DELETE ON billing_grace_periods
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();
