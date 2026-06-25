-- Authorized by HUB-1586 (E-BE-1 S3, CR-4 step 2 of 3) — rename every existing
-- `tenant_admin` row to `product_admin` AND emit a synthetic `audit_log` row per migrated
-- account in a single data-modifying CTE (R1 FIX#1 — preserves RETURNING semantics).
--
-- audit_log column mapping (real schema per HUB-1517 + HUB-1704):
--   tenant_id   = HUB-internal sentinel UUID '00000000-0000-0000-0000-0000000000a1'
--                 (same convention as HUB-1704 auth audit events; no FK on this column)
--   actor_id    = 'system:role-rename-migration' (per R1 spec)
--   actor_type  = 'system'
--   operation   = 'UPDATE'
--   table_name  = 'operator_accounts'
--   record_id   = the operator's UUID
--   new_values  = jsonb { email, event:'role.renamed', from:'tenant_admin', to:'product_admin' }
--   event_type  = NULL — 'role.renamed' is not in the HUB-1704 auth CHECK enumeration;
--                 this audit row identifies via actor_id + new_values.event instead.
--
-- Rollback: identify renamed rows via `SELECT new_values->>'email' FROM audit_log
--   WHERE actor_id='system:role-rename-migration'`, then UPDATE back. The CHECK
--   constraint must be widened first (re-apply 048).

WITH renamed AS (
  UPDATE operator_accounts
     SET role = 'product_admin'
   WHERE role = 'tenant_admin'
   RETURNING id, email
)
INSERT INTO audit_log (
  tenant_id, actor_id, actor_type, operation, table_name, record_id,
  new_values, occurred_at, created_at
)
SELECT
  '00000000-0000-0000-0000-0000000000a1'::uuid,
  'system:role-rename-migration',
  'system',
  'UPDATE',
  'operator_accounts',
  id,
  jsonb_build_object(
    'email', email,
    'event', 'role.renamed',
    'from',  'tenant_admin',
    'to',    'product_admin'
  ),
  NOW(),
  NOW()
FROM renamed;
