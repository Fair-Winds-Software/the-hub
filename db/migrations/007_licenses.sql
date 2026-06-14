-- Authorized by HUB-244 — licenses table; FSM status columns + delta tracking

CREATE TABLE IF NOT EXISTS licenses (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  product_id       UUID        NOT NULL REFERENCES product_registrations(id) ON DELETE RESTRICT,
  status           TEXT        NOT NULL CHECK (status IN ('pending','active','suspended','cancelled')),
  reason           VARCHAR(255),
  effective_date   DATE,
  staged_status    TEXT        CHECK (staged_status IN ('pending','active','suspended','cancelled')),
  staged_at        TIMESTAMPTZ,
  suspended_at     TIMESTAMPTZ,
  grace_expires_at TIMESTAMPTZ,
  delta_data       JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One license per (tenant, product) pair; duplicate INSERT → unique violation → AppError(409)
CREATE UNIQUE INDEX IF NOT EXISTS licenses_tenant_product_idx
  ON licenses (tenant_id, product_id);

-- CRON promotion query filters by status; partial index keeps it fast for active/pending rows
CREATE INDEX IF NOT EXISTS licenses_status_idx
  ON licenses (status);

-- Auto-stamp updated_at on every UPDATE; set_updated_at() defined in 005_settings_table.sql
CREATE TRIGGER licenses_updated_at
  BEFORE UPDATE ON licenses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- E1 delta pattern: covers BEFORE UPDATE (sets delta_data) and BEFORE DELETE (inserts into delta_log)
CREATE TRIGGER licenses_delta_tracker
  BEFORE UPDATE OR DELETE ON licenses
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();
