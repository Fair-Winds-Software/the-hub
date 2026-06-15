-- Authorized by HUB-608 — usage_events and cost_ledger tables; idempotency via idempotency_key UNIQUE

-- TODO-D-DEF-003: cost_ledger currently stores one row per usage_event (1:1).
--   Future work: per-event granularity for split-tier billing (multiple cost_ledger rows per
--   usage_event, one per tier entered). Requires cost_ledger schema extension and computeCost changes.

-- TODO-D-DEF-004: SDK buffer durability — idempotency_key deduplication is server-side only.
--   Future work: persistent SDK-side buffer with at-least-once delivery and server dedup to survive
--   SDK process restarts. Current design: best-effort; events not buffered on SDK crash.

CREATE TABLE usage_events (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL REFERENCES tenants(id),
  product_id       UUID        NOT NULL REFERENCES products(id),
  event_type       TEXT        NOT NULL,
  unit_count       INTEGER     NOT NULL CHECK (unit_count > 0),
  occurred_at      TIMESTAMPTZ NOT NULL,
  ingested_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ingested_late    BOOLEAN     NOT NULL DEFAULT false,
  idempotency_key  TEXT        UNIQUE,
  delta_data       JSONB
);

CREATE TABLE cost_ledger (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  usage_event_id    UUID        NOT NULL REFERENCES usage_events(id),
  tenant_id         UUID        NOT NULL REFERENCES tenants(id),
  product_id        UUID        NOT NULL REFERENCES products(id),
  pricing_model_id  UUID        REFERENCES pricing_models(id),
  cost_cents        INTEGER     NOT NULL CHECK (cost_cents >= 0),
  occurred_at       TIMESTAMPTZ NOT NULL,
  ingested_late     BOOLEAN     NOT NULL DEFAULT false,
  delta_data        JSONB
);

-- Indexes
CREATE INDEX idx_usage_events_tenant_product_occurred ON usage_events(tenant_id, product_id, occurred_at DESC);
CREATE INDEX idx_usage_events_product_occurred        ON usage_events(product_id, occurred_at DESC);
CREATE INDEX idx_cost_ledger_tenant_product_occurred  ON cost_ledger(tenant_id, product_id, occurred_at DESC);
CREATE INDEX idx_cost_ledger_usage_event              ON cost_ledger(usage_event_id);

-- Delta tracking (UPDATE + DELETE audit trail)
CREATE TRIGGER track_delta_usage_events
  BEFORE UPDATE OR DELETE ON usage_events
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

CREATE TRIGGER track_delta_cost_ledger
  BEFORE UPDATE OR DELETE ON cost_ledger
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();
