-- Authorized by HUB-1771 Phase 4 — universal_delta_tracker() referenced OLD.id
-- unconditionally on DELETE. Some tables (billing_period_costs, tenant_pricing_overrides,
-- product_registrations) don't have an `id` column — their DELETEs threw
-- SQLSTATE 42703 "record 'old' has no field 'id'".
--
-- Fix: use `to_jsonb(OLD)->>'id'` which returns NULL when the key is absent
-- instead of raising. delta_log.row_id was NOT NULL so we also relax that
-- constraint — for tables without id, we still want a delta_log entry keyed
-- by table_name; row_id NULL means "row identity not captured".

ALTER TABLE delta_log ALTER COLUMN row_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION public.universal_delta_tracker()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  old_row_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.delta_data := jsonb_build_object(
      'before',     to_jsonb(OLD) - 'delta_data',
      'after',      to_jsonb(NEW) - 'delta_data',
      'changed_at', NOW()
    );
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    -- OLD.id may not exist on tables without an id column; probe via jsonb.
    BEGIN
      old_row_id := (to_jsonb(OLD)->>'id')::uuid;
    EXCEPTION WHEN OTHERS THEN
      old_row_id := NULL;
    END;
    INSERT INTO delta_log (table_name, row_id, delta)
    VALUES (
      TG_TABLE_NAME,
      old_row_id,
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
