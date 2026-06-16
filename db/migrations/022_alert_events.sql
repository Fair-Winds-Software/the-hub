-- Authorized by HUB-706 — alert_events table, dedup partial index, universal_delta_tracker trigger

CREATE TABLE alert_events (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL REFERENCES tenants(id)  ON DELETE CASCADE,
  product_id       UUID        NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  alert_type       TEXT        NOT NULL,
  severity         TEXT        NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  payload          JSONB       NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'acknowledged', 'resolved')),
  dedup_key        TEXT,
  first_fired_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_fired_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fire_count       INT         NOT NULL DEFAULT 1 CHECK (fire_count >= 1),
  acknowledged_at  TIMESTAMPTZ,
  resolved_at      TIMESTAMPTZ,
  delta_data       JSONB
);

-- Partial unique index: ON CONFLICT target for ingestAlert() upsert
-- Applies only when status='new' and a dedup_key is supplied (NULL dedup_key always inserts)
CREATE UNIQUE INDEX alert_events_dedup_idx
  ON alert_events (tenant_id, product_id, alert_type, dedup_key)
  WHERE status = 'new' AND dedup_key IS NOT NULL;

-- Composite index for dedup lookup and list filtering (tenant, product, type, status)
CREATE INDEX idx_alert_events_tenant_product_type_status
  ON alert_events (tenant_id, product_id, alert_type, status);

-- Operator list endpoint: tenant + status fast path
CREATE INDEX idx_alert_events_tenant_status
  ON alert_events (tenant_id, status);

-- Delta tracking (UPDATE + DELETE audit trail)
CREATE TRIGGER track_delta_alert_events
  BEFORE UPDATE OR DELETE ON alert_events
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();
