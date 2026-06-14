-- Authorized by HUB-287 — tenant_feature_overrides table; per-tenant gate override storage
CREATE TABLE IF NOT EXISTS tenant_feature_overrides (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id      UUID         NOT NULL REFERENCES product_registrations(id) ON DELETE RESTRICT,
  gate_key        VARCHAR(255) NOT NULL,
  enabled         BOOLEAN      NOT NULL,
  override_reason TEXT,
  set_by          TEXT         NOT NULL,
  set_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  delta_data      JSONB,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS tfo_tenant_product_gate_idx ON tenant_feature_overrides (tenant_id, product_id, gate_key);
CREATE INDEX IF NOT EXISTS tfo_product_key_idx ON tenant_feature_overrides (product_id, gate_key);

CREATE TRIGGER tfo_delta_tracker
  BEFORE UPDATE OR DELETE ON tenant_feature_overrides
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();
