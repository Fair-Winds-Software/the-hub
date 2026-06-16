-- Authorized by HUB-780 — escalation_rules and escalation_events tables; 2-tier cap via CHECK; idempotency via UNIQUE

CREATE TABLE IF NOT EXISTS escalation_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  alert_type TEXT NOT NULL,
  tier INT NOT NULL CHECK (tier BETWEEN 1 AND 2),
  threshold_minutes INT NOT NULL CHECK (threshold_minutes > 0),
  escalation_contacts JSONB NOT NULL,
  delta_data JSONB,
  UNIQUE (tenant_id, product_id, alert_type, tier)
);

CREATE TABLE IF NOT EXISTS escalation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_event_id UUID NOT NULL REFERENCES alert_events(id) ON DELETE CASCADE,
  tier INT NOT NULL,
  fired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data JSONB,
  UNIQUE (alert_event_id, tier)
);

-- Scanner performance index: covers WHERE status='new' ORDER BY first_fired_at ASC
CREATE INDEX IF NOT EXISTS idx_alert_events_status_fired ON alert_events(status, first_fired_at);

CREATE TRIGGER escalation_rules_delta
  AFTER INSERT OR UPDATE ON escalation_rules
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

CREATE TRIGGER escalation_events_delta
  AFTER INSERT OR UPDATE ON escalation_events
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();
