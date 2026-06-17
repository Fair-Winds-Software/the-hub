-- Authorized by HUB-1022 — operator_accounts table; operator_refresh_tokens table; delta_data + universal_delta_tracker

CREATE TABLE IF NOT EXISTS operator_accounts (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT        UNIQUE NOT NULL,
  password_hash TEXT        NOT NULL,
  role          TEXT        NOT NULL CHECK (role IN ('super_admin', 'tenant_admin')),
  tenant_id     UUID        REFERENCES tenants(id) ON DELETE RESTRICT,
  active        BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data    JSONB
);

CREATE INDEX IF NOT EXISTS idx_operator_accounts_email ON operator_accounts(email);

CREATE TRIGGER track_delta_operator_accounts
  BEFORE UPDATE OR DELETE ON operator_accounts
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

CREATE TABLE IF NOT EXISTS operator_refresh_tokens (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id UUID        NOT NULL REFERENCES operator_accounts(id) ON DELETE CASCADE,
  token_hash  TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked     BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
