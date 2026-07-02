-- Authorized by HUB-1661 (E-FE-6 S2) — nullable archived_at timestamp on
-- escalation_rules. Same soft-archive pattern as migration 058 for
-- notification_channels + earlier 056/057 for plans/add-ons.
--
-- Spec deviation: story description named this file 055_ but next
-- available slot is 059 after the HUB-1651/1652 renumber cascade.
--
-- Note: the escalation-rules table has a UNIQUE constraint on
-- (tenant_id, product_id, alert_type, tier) enforcing the 2-tier limit at
-- the POST route (handler at notifications.ts:308). With soft-archive, an
-- archived tier still occupies the unique slot until a hard purge — the
-- v0.1 UX side-steps this because Restore is not yet exposed and archived
-- rows filter out of the tier-count check via WHERE archived_at IS NULL.
-- If Restore is added later, the count-check query must add the same
-- clause to stay correct. Documented for HUB-1666 (S7) consumer.
--
-- Rollback: DROP COLUMN archived_at + DROP INDEX ...

ALTER TABLE escalation_rules
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS escalation_rules_archived_at_idx
  ON escalation_rules (archived_at)
  WHERE archived_at IS NULL;

COMMENT ON COLUMN escalation_rules.archived_at IS
  'HUB-1661 (E-FE-6 S2): NULL = active, non-NULL = soft-archived. Set atomically via the DELETE /api/v1/admin/escalation/:tenantId/:productId/rules/:ruleId route.';
