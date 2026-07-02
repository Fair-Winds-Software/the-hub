-- Authorized by HUB-1652 (E-FE-5 S2) — nullable archived_at timestamp on add_ons.
--
-- Spec deviation: the story description named this file 051_add_ons_archived_at.sql,
-- but slots 051..056 are already taken (051..055 pre-existing, 056 = HUB-1651
-- plans_archived_at). Next available slot is 057 — same renumber pattern used by
-- HUB-1651 (spec 050 → 056).
--
-- Semantics mirror the plans column added in 056_plans_archived_at.sql:
-- archived_at IS NULL <=> active. Historical rows carrying active=false backfill
-- archived_at = updated_at. New soft-archive path (HUB-1652 route +
-- softArchiveAddOn service extension) sets BOTH active=false and archived_at=NOW()
-- atomically. Reads via the HUB-1652 GET route filter on archived_at IS NULL when
-- includeArchived=false. The pre-existing `active` column stays for backward
-- compatibility with pre-HUB-1652 consumers of addOnService.
--
-- Rollback: DROP COLUMN archived_at + DROP INDEX add_ons_archived_at_idx.

ALTER TABLE add_ons
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NULL;

UPDATE add_ons
   SET archived_at = updated_at
 WHERE active = false
   AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS add_ons_archived_at_idx
  ON add_ons (archived_at)
  WHERE archived_at IS NULL;

COMMENT ON COLUMN add_ons.archived_at IS
  'HUB-1652 (E-FE-5 S2): NULL = active, non-NULL = soft-archived. Set atomically with active=false via the DELETE /api/v1/admin/addons/:addonId route.';