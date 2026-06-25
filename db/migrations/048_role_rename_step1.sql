-- Authorized by HUB-1586 (E-BE-1 S3, CR-4 step 1 of 3) — widen operator_accounts.role
-- CHECK constraint to accept the legacy + new role values during the same-deploy migration
-- window. Steps 2 + 3 (049 + 050) tighten the constraint after data is migrated.
--
-- Renumbered from spec's 047 to 048 (045 = HUB-1704; 046 = HUB-1584; 047 = HUB-1585).
-- Steps 2/3 follow at 049/050.
--
-- Rollback (only valid if 049 + 050 have NOT yet applied): DROP CONSTRAINT + restore the
-- prior {super_admin, tenant_admin} CHECK. After 050 ships, rollback requires un-renaming
-- product_admin rows back to tenant_admin first — strongly prefer feature-flag gating.

ALTER TABLE operator_accounts
  DROP CONSTRAINT IF EXISTS operator_accounts_role_check;

ALTER TABLE operator_accounts
  ADD CONSTRAINT operator_accounts_role_check
  CHECK (role IN ('super_admin', 'tenant_admin', 'product_admin'));
