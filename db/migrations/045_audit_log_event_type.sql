-- Authorized by HUB-1704 (CR-6 under HUB-1556) — add event_type to audit_log for non-CRUD
-- auth events (login/logout/refresh). Existing CRUD audit shape (operation + table_name)
-- remains unchanged; event_type adds a new dimension that operator-auth flows populate.
-- Unblocks HUB-1580 (E-FE-1 S11) SOC 2 audit-trail verification per D-HUB-SCOPE-028.

ALTER TABLE audit_log
  ADD COLUMN event_type TEXT NULL;

-- CHECK constraint enumerates the v0.1 auth event vocabulary. Add new event types via
-- a future ALTER ... DROP CONSTRAINT / ADD CONSTRAINT migration; do not bypass.
ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_event_type_check
  CHECK (event_type IS NULL OR event_type IN (
    'auth.login.success',
    'auth.login.failure',
    'auth.logout',
    'auth.refresh_token.revoked'
  ));

-- Partial index — auth event lookups by actor for SOC 2 evidence retrieval are cheap
-- without scanning the full CRUD audit history.
CREATE INDEX audit_log_auth_events
  ON audit_log (actor_id, occurred_at DESC)
  WHERE event_type IS NOT NULL;
