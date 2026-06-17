-- Authorized by HUB-1499 — composite index on alert_events for summary query performance
CREATE INDEX IF NOT EXISTS idx_alert_events_tenant_status_severity
  ON alert_events(tenant_id, status, severity);
