-- Authorized by HUB-245 — staged_license_changes table; effective-dated license change queue (D-002)
-- Depends on: 007_licenses.sql (licenses table must exist for FK)

CREATE TABLE IF NOT EXISTS staged_license_changes (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  license_id    UUID        NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  new_status    TEXT        NOT NULL CHECK (new_status IN ('pending','active','suspended','cancelled')),
  change_reason TEXT,
  staged_by     TEXT        NOT NULL,
  staged_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  promoted_at   TIMESTAMPTZ,
  delta_data    JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- CRON promotion query joins staged_license_changes to licenses on license_id
CREATE INDEX IF NOT EXISTS staged_lc_license_idx
  ON staged_license_changes (license_id);

-- Partial index: CRON filters unpromoted rows only; keeps scans fast as history accumulates
CREATE INDEX IF NOT EXISTS staged_lc_unpromoted_idx
  ON staged_license_changes (staged_at)
  WHERE promoted_at IS NULL;

-- E1 delta pattern
CREATE TRIGGER staged_lc_delta_tracker
  BEFORE UPDATE OR DELETE ON staged_license_changes
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();
