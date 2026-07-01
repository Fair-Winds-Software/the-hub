-- Authorized by HUB-1651 (E-FE-5 S1) — nullable archived_at timestamp on plans.
--
-- Spec deviation: the story description named this file 050_plans_archived_at.sql,
-- but 050 (role rename step 3) and 051-055 are already taken by prior HUB stories.
-- Next available slot is 056 — same pattern used by 046_billing_mode.sql
-- ("Renumbered from the spec's 045 to 046 because HUB-1704 took the 045 slot").
--
-- Semantics: archived_at IS NULL <=> active. Historical rows already carrying
-- active=false backfill archived_at = updated_at so the two columns stay in
-- sync without churning the ledger. New code paths (HUB-1651 route + service
-- extension) set BOTH active=false and archived_at=NOW() atomically inside
-- the soft-archive transaction; read paths use `archived_at IS NULL` as the
-- canonical "active plan" predicate going forward. The `active` column stays
-- for backward compatibility with pre-HUB-1651 consumers of planCatalogService.
--
-- Rollback: DROP COLUMN archived_at + DROP INDEX plans_archived_at_idx.
-- Consumers wired in this Epic (S5 FE + downstream) key on archived_at IS NULL
-- so rollback requires a coordinated FE revert.

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NULL;

UPDATE plans
   SET archived_at = updated_at
 WHERE active = false
   AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS plans_archived_at_idx
  ON plans (archived_at)
  WHERE archived_at IS NULL;

COMMENT ON COLUMN plans.archived_at IS
  'HUB-1651 (E-FE-5 S1): NULL = active, non-NULL = soft-archived. Set atomically with active=false via the DELETE /api/v1/admin/plans/:planId route.';
