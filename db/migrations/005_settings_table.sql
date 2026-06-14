-- Authorized by HUB-126 — settings table; E1 delta pattern applied

-- set_updated_at: reusable BEFORE UPDATE trigger function that auto-stamps updated_at.
-- Defined here as settings is the first table that needs it; subsequent tables reuse it.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS settings (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  key         TEXT        UNIQUE NOT NULL,
  value       JSONB       NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data  JSONB
);

-- Auto-stamp updated_at on every UPDATE; fires before track_delta_settings so the
-- delta 'after' snapshot captures the already-updated timestamp.
CREATE TRIGGER settings_updated_at
  BEFORE UPDATE ON settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- E1 delta pattern: single trigger covers both UPDATE (sets delta_data) and
-- DELETE (inserts into delta_log). Follows the pattern documented in 002.
CREATE TRIGGER track_delta_settings
  BEFORE UPDATE OR DELETE ON settings
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();
