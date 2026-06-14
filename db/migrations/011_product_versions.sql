-- Authorized by HUB-321 — product_versions table; product-level SDK version registry and compatibility status
CREATE TABLE IF NOT EXISTS product_versions (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id      UUID         NOT NULL REFERENCES product_registrations(id) ON DELETE RESTRICT,
  version         VARCHAR(50)  NOT NULL,
  status          TEXT         NOT NULL CHECK (status IN ('supported', 'deprecated', 'sunset')),
  deprecated_at   TIMESTAMPTZ,
  sunset_at       TIMESTAMPTZ,
  release_notes   TEXT,
  created_by      TEXT         NOT NULL,
  delta_data      JSONB,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS pv_product_version_idx ON product_versions (product_id, version);
CREATE INDEX IF NOT EXISTS pv_product_status_idx ON product_versions (product_id, status);

CREATE TRIGGER pv_updated_at
  BEFORE UPDATE ON product_versions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER pv_delta_tracker
  BEFORE UPDATE OR DELETE ON product_versions
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();
