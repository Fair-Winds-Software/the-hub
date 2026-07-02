-- Authorized by HUB-1661 (E-FE-6 S2) — nullable archived_at timestamp on
-- notification_channels. Converts the hard-delete DELETE handler at
-- notifications.ts:291 into a soft-archive UPDATE per the same pattern as
-- HUB-1651 plans + HUB-1652 add-ons (archived_at IS NULL <=> active).
--
-- Spec deviation: story description named this file 054_ but 054..057 are
-- already taken; next available is 058. Same +1 pattern used by the other
-- HUB-1651/1652 renumbers.
--
-- Semantics: archived_at IS NULL <=> active. All existing rows on this
-- table already represent "not archived"; no backfill is needed because
-- the pre-HUB-1661 codebase hard-deleted instead of tombstoning. New
-- soft-archive path (HUB-1661 route refactor) sets archived_at=NOW()
-- atomically inside the UPDATE. Reads via the HUB-1661 GET filter on
-- archived_at IS NULL when includeArchived=false.
--
-- Rollback: DROP COLUMN archived_at + DROP INDEX ...

ALTER TABLE notification_channels
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS notification_channels_archived_at_idx
  ON notification_channels (archived_at)
  WHERE archived_at IS NULL;

COMMENT ON COLUMN notification_channels.archived_at IS
  'HUB-1661 (E-FE-6 S2): NULL = active, non-NULL = soft-archived. Set atomically via the DELETE /api/v1/admin/notifications/:tenantId/:productId/channels/:channelId route.';
