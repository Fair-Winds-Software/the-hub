-- Authorized by HUB-322 — sdk_version_reports table; per-tenant SDK version upsert storage
CREATE TABLE IF NOT EXISTS sdk_version_reports (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id  UUID         NOT NULL REFERENCES product_registrations(id) ON DELETE RESTRICT,
  sdk_version VARCHAR(50)  NOT NULL,
  reported_at TIMESTAMPTZ  NOT NULL,
  delta_data  JSONB,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS svr_tenant_product_idx ON sdk_version_reports (tenant_id, product_id);
CREATE INDEX IF NOT EXISTS svr_reported_at_idx ON sdk_version_reports (reported_at DESC);

-- No set_updated_at trigger — reported_at serves as the mutation timestamp
CREATE TRIGGER svr_delta_tracker
  BEFORE UPDATE OR DELETE ON sdk_version_reports
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();
