-- Authorized by HUB-1098 — alert_notifications (immutable), alert_acknowledgments, alert_rules schemas

-- ── alert_notifications: immutable append-only alert log ──────────────────────
-- content_hash UNIQUE enforces deduplication across all alert engines.
-- No UPDATE/DELETE permitted; no delta_data column.
CREATE TABLE IF NOT EXISTS alert_notifications (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id         UUID        REFERENCES products(id),
  control_id         UUID        REFERENCES compliance_controls(id),
  alert_type         TEXT        NOT NULL,
  severity           TEXT        NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  payload            JSONB       NOT NULL,
  channels_targeted  TEXT[]      NOT NULL DEFAULT '{}',
  fired_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  content_hash       TEXT        NOT NULL,
  CONSTRAINT alert_notifications_content_hash_uq UNIQUE (content_hash)
);
CREATE INDEX IF NOT EXISTS idx_alert_notifications_product ON alert_notifications(product_id);
CREATE INDEX IF NOT EXISTS idx_alert_notifications_fired ON alert_notifications(fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_notifications_type ON alert_notifications(alert_type);

-- ── alert_acknowledgments: mutable per-notification acknowledgment ─────────────
CREATE TABLE IF NOT EXISTS alert_acknowledgments (
  notification_id  UUID        PRIMARY KEY REFERENCES alert_notifications(id),
  acknowledged_by  TEXT        NOT NULL,
  acknowledged_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data       JSONB
);

CREATE TRIGGER track_delta_alert_acknowledgments
  BEFORE UPDATE OR DELETE ON alert_acknowledgments
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

-- ── alert_rules: configurable thresholds per product or platform-wide ──────────
-- product_id NULL = platform-wide rule; product-specific rules override platform-wide.
CREATE TABLE IF NOT EXISTS alert_rules (
  id                           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id                   UUID        REFERENCES products(id),
  rule_type                    TEXT        NOT NULL,
  threshold_value              NUMERIC,
  escalation_delay_hours       INT,
  assignee_account_id          TEXT,
  fallback_assignee_account_id TEXT,
  enabled                      BOOLEAN     NOT NULL DEFAULT true,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data                   JSONB
);
CREATE INDEX IF NOT EXISTS idx_alert_rules_type ON alert_rules(rule_type);
CREATE INDEX IF NOT EXISTS idx_alert_rules_product ON alert_rules(product_id);

CREATE TRIGGER track_delta_alert_rules
  BEFORE UPDATE OR DELETE ON alert_rules
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

-- Seed platform-wide default rules
INSERT INTO alert_rules (rule_type, threshold_value, enabled)
VALUES
  ('control_failure',       NULL,  true),
  ('human_overdue',         NULL,  true),
  ('drift_detected',        10.0,  true)
ON CONFLICT DO NOTHING;
