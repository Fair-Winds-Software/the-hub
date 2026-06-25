-- Authorized by HUB-1586 (E-BE-1 S3, CR-4 step 3 of 3) — narrow operator_accounts.role
-- CHECK constraint back to the canonical {super_admin, product_admin}. 048 widened it;
-- 049 migrated the data; this step drops `tenant_admin` from the accepted set so any
-- future INSERT/UPDATE attempting it fails with a check_violation (23514).
--
-- Pre-condition: 049 ran cleanly — no rows with role='tenant_admin' remain. If 049
-- failed mid-step, this migration would fail too (the CHECK would reject the surviving
-- tenant_admin rows). The migration runner's per-file transaction guarantees that 049
-- and 050 either both succeed or both leave the constraint in the widened state from 048.
--
-- Rollback: re-apply 048 (widen back) THEN UPDATE rows back to tenant_admin THEN re-apply
-- this file with the legacy CHECK. Almost always cheaper to feature-flag forward.

ALTER TABLE operator_accounts
  DROP CONSTRAINT operator_accounts_role_check;

ALTER TABLE operator_accounts
  ADD CONSTRAINT operator_accounts_role_check
  CHECK (role IN ('super_admin', 'product_admin'));
