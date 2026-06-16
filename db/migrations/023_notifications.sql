-- Authorized by HUB-731 — notification_channels, notification_deliveries, in_app_notifications tables with delta tracking

CREATE TABLE notification_channels (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID        NOT NULL REFERENCES tenants(id)  ON DELETE CASCADE,
  product_id   UUID        NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  channel_type TEXT        NOT NULL CHECK (channel_type IN ('email', 'webhook', 'in_app')),
  config       JSONB       NOT NULL,
  hmac_secret  TEXT,
  enabled      BOOLEAN     NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data   JSONB,
  UNIQUE (tenant_id, product_id, channel_type)
);

CREATE TABLE notification_deliveries (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_event_id  UUID        NOT NULL REFERENCES alert_events(id) ON DELETE CASCADE,
  channel_id      UUID        NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
  status          TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  error           TEXT,
  delta_data      JSONB
);

CREATE INDEX idx_notification_deliveries_alert_event ON notification_deliveries (alert_event_id);

CREATE TABLE in_app_notifications (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        NOT NULL REFERENCES tenants(id)  ON DELETE CASCADE,
  product_id      UUID        NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  alert_event_id  UUID        NOT NULL REFERENCES alert_events(id) ON DELETE CASCADE,
  message         TEXT        NOT NULL,
  read            BOOLEAN     NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data      JSONB
);

CREATE INDEX idx_in_app_notifications_tenant_read ON in_app_notifications (tenant_id, read);

CREATE TRIGGER track_delta_notification_channels
  BEFORE UPDATE OR DELETE ON notification_channels
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

CREATE TRIGGER track_delta_notification_deliveries
  BEFORE UPDATE OR DELETE ON notification_deliveries
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

CREATE TRIGGER track_delta_in_app_notifications
  BEFORE UPDATE OR DELETE ON in_app_notifications
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();
