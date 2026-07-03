-- Authorized by HUB-1545 (System Health spec-deviation close-out) — codify the
-- stripe_webhook_events.status vocabulary via a CHECK constraint and introduce
-- 'pending_retry' as a first-class value written by the BullMQ failed-event
-- listener when a stripe queue job has attempts remaining. Removes the deferred
-- workaround where /admin/system-health/stripe-webhooks always returned
-- pendingRetryCount = 0 because no code path ever wrote the value.
--
-- Vocabulary:
--   received     — row was INSERTed by the webhook handler (default)
--   dispatched   — job successfully added to a BullMQ event-type queue
--   pending_retry — BullMQ processor failed with attempts remaining
--   processed    — reserved for successful-completion handler wire-up (v0.2)
--   failed       — permanently failed (attempts exhausted, moved to DLQ)

ALTER TABLE stripe_webhook_events
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;

ALTER TABLE stripe_webhook_events
  DROP CONSTRAINT IF EXISTS stripe_webhook_events_status_check;

ALTER TABLE stripe_webhook_events
  ADD CONSTRAINT stripe_webhook_events_status_check
  CHECK (status IN ('received', 'dispatched', 'pending_retry', 'processed', 'failed'));

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_status_received_at
  ON stripe_webhook_events (status, received_at DESC);
