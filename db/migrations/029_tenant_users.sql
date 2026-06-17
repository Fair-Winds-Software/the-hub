-- Authorized by HUB-1506 — tenant_users table; portal auth credentials; delta_data + universal_delta_tracker trigger

CREATE TABLE IF NOT EXISTS tenant_users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email         TEXT        NOT NULL,
  password_hash TEXT        NOT NULL,
  active        BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data    JSONB,
  CONSTRAINT tenant_users_tenant_email_uq UNIQUE (tenant_id, email)
);

CREATE INDEX IF NOT EXISTS idx_tenant_users_tenant
  ON tenant_users(tenant_id);

CREATE TRIGGER track_delta_tenant_users
  BEFORE UPDATE OR DELETE ON tenant_users
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

-- Rollback:
-- DROP TRIGGER IF EXISTS track_delta_tenant_users ON tenant_users;
-- DROP INDEX IF EXISTS idx_tenant_users_tenant;
-- DROP TABLE IF EXISTS tenant_users;
