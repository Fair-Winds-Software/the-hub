-- Authorized by HUB-1771 Phase 4 — real product bug: universal_delta_tracker()
-- snapshots OLD/NEW via to_jsonb() which INCLUDES the row's own delta_data
-- column. On each UPDATE, delta_data absorbs the previous delta_data snapshot,
-- growing roughly O(2^n). After ~28 updates the row hits Postgres' 256MB JSONB
-- cap and the trigger throws SQLSTATE 54000 "total size of jsonb object
-- elements exceeds the maximum". Synapz shipped the same fix in their
-- migration 0056; see workspace memory feedback_delta_tracker_recursion.md.
--
-- Fix: strip 'delta_data' from OLD/NEW jsonb before serializing so the snapshot
-- captures only the meaningful before/after state, not its own tombstone.
--
-- Also: reset the stale delta_data on `settings` (only table that has been
-- hit in the test suite). Other tables are safe until their per-row update
-- count exceeds the same threshold.

CREATE OR REPLACE FUNCTION public.universal_delta_tracker()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.delta_data := jsonb_build_object(
      'before',     to_jsonb(OLD) - 'delta_data',
      'after',      to_jsonb(NEW) - 'delta_data',
      'changed_at', NOW()
    );
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO delta_log (table_name, row_id, delta)
    VALUES (
      TG_TABLE_NAME,
      OLD.id,
      jsonb_build_object(
        'before',     to_jsonb(OLD) - 'delta_data',
        'deleted_at', NOW(),
        'table_name', TG_TABLE_NAME
      )
    );
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$function$;

-- Reset stale delta_data on `settings` — the only table whose delta_data
-- has actually blown up under the current test suite. Preserves the values
-- themselves. Uses UPDATE ... SET WHERE to avoid re-triggering the (now fixed)
-- delta_tracker unnecessarily by only touching rows whose delta_data is non-null.
UPDATE settings SET delta_data = NULL WHERE delta_data IS NOT NULL;
