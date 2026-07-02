-- Authorized by HUB-1661 (E-FE-6 S2) — nullable archived_at timestamp on
-- workflow_hooks. Same soft-archive pattern as migrations 058/059.
--
-- Spec deviation: story description named this file 056_ but next
-- available slot is 060.
--
-- Rollback: DROP COLUMN archived_at + DROP INDEX ...

ALTER TABLE workflow_hooks
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS workflow_hooks_archived_at_idx
  ON workflow_hooks (archived_at)
  WHERE archived_at IS NULL;

COMMENT ON COLUMN workflow_hooks.archived_at IS
  'HUB-1661 (E-FE-6 S2): NULL = active, non-NULL = soft-archived. Set atomically via the DELETE /api/v1/admin/hooks/:tenantId/:hookId route.';
