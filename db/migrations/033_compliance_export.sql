-- Authorized by HUB-1377 — compliance_export_jobs schema: status tracking, filter params, bundle_path
-- Authorized by HUB-1380 — compliance_export_jobs schema: bundle_hash, record_count columns
-- Authorized by HUB-1382 — compliance_export_jobs: export job API backing table

CREATE TABLE IF NOT EXISTS compliance_export_jobs (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by     TEXT        NOT NULL,
  product_id       UUID        REFERENCES products(id),
  tsc_category     TEXT,
  control_class    TEXT,
  date_from        TIMESTAMPTZ NOT NULL,
  date_to          TIMESTAMPTZ NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  bundle_path      TEXT,
  bundle_hash      TEXT,
  record_count     INT,
  error_message    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,
  delta_data       JSONB
);

CREATE INDEX IF NOT EXISTS idx_export_jobs_status ON compliance_export_jobs(status);
CREATE INDEX IF NOT EXISTS idx_export_jobs_requested_by ON compliance_export_jobs(requested_by);
CREATE INDEX IF NOT EXISTS idx_export_jobs_created ON compliance_export_jobs(created_at DESC);

CREATE TRIGGER track_delta_compliance_export_jobs
  BEFORE UPDATE OR DELETE ON compliance_export_jobs
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();
