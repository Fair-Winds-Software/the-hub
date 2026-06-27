-- Authorized by HUB-1697 (E-BE-1 S20) — composite index on operator_audit_log to support
--   the common AC#5 filter path: product_admin = `WHERE tenant_id=X AND product_id=Y
--   ORDER BY created_at DESC`. Existing 035_operator_console.sql created separate single-
--   column indexes on tenant_id, product_id, created_at; a composite is needed for the
--   product_admin tenant+product scan to plan efficiently as the audit table grows.
--
-- Spec note: HUB-1697 R2 locked migration number `048_audit_log_filter_indexes.sql` per
-- D-HUB-SCOPE-036, but 048 was consumed by the role-rename trio (HUB-1587 chain) before
-- this story ran. Using next available number (053) and naming for the actual backing
-- table (operator_audit_log, not audit_log). Story spec's generic "audit_log" naming is
-- clarified in route + service code comments.

CREATE INDEX IF NOT EXISTS idx_operator_audit_log_tenant_product_created
  ON operator_audit_log(tenant_id, product_id, created_at DESC);
