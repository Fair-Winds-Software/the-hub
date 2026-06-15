-- Authorized by HUB-363 — leases table migration; Signed Lease Service durable store
-- Authorized by HUB-524 — AES-256-GCM encrypted lease_token, D-DEF-002 renews_at, delta tracking
CREATE TABLE IF NOT EXISTS leases (
  id                   UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id           UUID          NOT NULL,
  lease_token          TEXT          NOT NULL,
  signed_payload       TEXT          NOT NULL,
  issued_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  expires_at           TIMESTAMPTZ   NOT NULL,
  renews_at            TIMESTAMPTZ   NOT NULL,
  revoked_at           TIMESTAMPTZ,
  revoke_reason        VARCHAR(255),
  sdk_version_at_issue VARCHAR(50)   NOT NULL,
  gate_snapshot        JSONB         NOT NULL,
  delta_data           JSONB,
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT leases_revoke_consistency CHECK (
    (revoked_at IS NULL AND revoke_reason IS NULL) OR
    (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS leases_tenant_product_idx ON leases (tenant_id, product_id);
CREATE INDEX IF NOT EXISTS leases_active_idx ON leases (tenant_id, product_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS leases_expires_active_idx ON leases (expires_at) WHERE revoked_at IS NULL;

CREATE TRIGGER leases_updated_at
  BEFORE UPDATE ON leases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER leases_delta_tracker
  BEFORE UPDATE OR DELETE ON leases
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();
