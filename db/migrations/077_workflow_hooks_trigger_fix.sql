-- Authorized by HUB-1771 Phase 4 — real product bug: migration 025 defined
-- universal_delta_tracker_workflow_hooks as BEFORE INSERT OR UPDATE. The
-- universal_delta_tracker() function returns NULL for TG_OP='INSERT' (no
-- matching branch); returning NULL from a BEFORE INSERT trigger tells
-- Postgres to SKIP the row, so every INSERT into workflow_hooks silently
-- succeeded with 0 rows affected. Callers doing `pool.query(INSERT ...
-- RETURNING id)` got empty rows and crashed on rows[0].id.
--
-- Same defect applies to universal_delta_tracker_workflow_hook_executions.
-- Every OTHER table using this function correctly uses AFTER INSERT OR
-- UPDATE OR DELETE (e.g. escalation_rules_delta at migration 024).
--
-- Fix: drop + recreate the two triggers as AFTER, and add DELETE to the
-- trigger event list so the function's DELETE branch actually fires.

DROP TRIGGER IF EXISTS universal_delta_tracker_workflow_hooks ON workflow_hooks;
CREATE TRIGGER workflow_hooks_delta
  AFTER INSERT OR UPDATE OR DELETE ON workflow_hooks
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

DROP TRIGGER IF EXISTS universal_delta_tracker_workflow_hook_executions ON workflow_hook_executions;
CREATE TRIGGER workflow_hook_executions_delta
  AFTER INSERT OR UPDATE OR DELETE ON workflow_hook_executions
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();
