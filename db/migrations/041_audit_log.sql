-- Authorized by HUB-1516 — audit_log table; INSERT-only grant for hub_app; composite index (tenant_id, created_at DESC)

CREATE TABLE audit_log (
  id          UUID        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL,
  product_id  UUID,
  actor_id    TEXT,
  actor_type  TEXT,
  operation   TEXT        NOT NULL,
  table_name  TEXT        NOT NULL,
  record_id   UUID,
  old_values  JSONB,
  new_values  JSONB,
  delta_data  JSONB,
  ip_address  TEXT,
  trace_id    TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

CREATE INDEX audit_log_tenant_created ON audit_log (tenant_id, created_at DESC);

-- hub_app may only INSERT — compliance-grade immutability; no FK on actor_id (actors span operators, tenant users, system)
GRANT INSERT ON audit_log TO hub_app;
REVOKE UPDATE, DELETE ON audit_log FROM hub_app;
