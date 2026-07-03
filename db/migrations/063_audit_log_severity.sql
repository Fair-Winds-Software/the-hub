-- Authorized by HUB-1545 (System Health spec-deviation close-out) —
-- introduce first-class severity on audit_log so /admin/system-health/
-- audit-errors + the portfolio error-rate rollup can filter by severity
-- instead of the fragile `event_type LIKE '%.failure'` proxy.
--
-- Values: 'info' (default; CRUD + success events), 'warn' (reserved),
--         'error' (permanent failure or explicit ops-worthy audit event).
--
-- Backfill: existing rows with event_type ending in `.failure` are set to
-- 'error'; everything else remains 'info'.

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS severity TEXT NOT NULL DEFAULT 'info';

ALTER TABLE audit_log
  DROP CONSTRAINT IF EXISTS audit_log_severity_check;

ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_severity_check
  CHECK (severity IN ('info', 'warn', 'error'));

UPDATE audit_log
   SET severity = 'error'
 WHERE severity = 'info'
   AND event_type LIKE '%.failure';

-- Index for the two hot read paths — /audit-errors filters by severity +
-- occurred_at DESC, and the /portfolio rollup does a
-- product_id-scoped severity aggregate over the last 24h.
CREATE INDEX IF NOT EXISTS idx_audit_log_severity_occurred
  ON audit_log (severity, occurred_at DESC)
  WHERE severity = 'error';
