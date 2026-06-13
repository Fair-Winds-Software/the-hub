-- Authorized by HUB-51 — delta_log table, universal_delta_tracker() trigger function, triggers on E1 tables

-- Append-only audit log for physically-deleted rows.
-- Intentionally excluded from universal_delta_tracker (second explicit exception alongside schema_migrations).
CREATE TABLE IF NOT EXISTS delta_log (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name TEXT        NOT NULL,
  row_id     UUID        NOT NULL,
  delta      JSONB       NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- universal_delta_tracker: single trigger function covering UPDATE and DELETE operations.
--
-- UPDATE (BEFORE): sets delta_data on the mutating row with before/after/changed_at snapshot.
--   BEFORE timing is required — AFTER UPDATE cannot modify the stored row (return value is discarded).
--
-- DELETE (BEFORE DELETE): inserts an audit record into delta_log before the row is removed.
--   BEFORE timing is required — AFTER DELETE cannot capture OLD into a sibling table cleanly.
--
-- INSERT: trigger is not applied on INSERT; delta_data remains NULL (no OLD row exists).
--
-- Explicit exclusions (no trigger applied):
--   schema_migrations — infrastructure table, no audit semantics
--   delta_log         — would cause infinite recursion
CREATE OR REPLACE FUNCTION universal_delta_tracker()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.delta_data := jsonb_build_object(
      'before',     to_jsonb(OLD),
      'after',      to_jsonb(NEW),
      'changed_at', NOW()
    );
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO delta_log (table_name, row_id, delta)
    VALUES (
      TG_TABLE_NAME,
      OLD.id,
      jsonb_build_object(
        'before',     to_jsonb(OLD),
        'deleted_at', NOW(),
        'table_name', TG_TABLE_NAME
      )
    );
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

-- Apply to all E1 tables.
-- Pattern for every future table migration:
--   CREATE TRIGGER track_delta_{table}
--     BEFORE UPDATE OR DELETE ON {table}
--     FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();
-- CI introspection test enforces this pattern across all Epics.

CREATE TRIGGER track_delta_tenants
  BEFORE UPDATE OR DELETE ON tenants
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

CREATE TRIGGER track_delta_products
  BEFORE UPDATE OR DELETE ON products
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

CREATE TRIGGER track_delta_product_registrations
  BEFORE UPDATE OR DELETE ON product_registrations
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();
