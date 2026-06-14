-- Authorized by HUB-175 — stripe_webhook_events table; idempotency guard and audit schema

-- event_id UNIQUE is the database-layer idempotency guard for Stripe webhook delivery.
-- Duplicate event_id insert → unique constraint violation → application returns 200.
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     TEXT        UNIQUE NOT NULL,
  event_type   TEXT        NOT NULL,
  product_id   TEXT,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  status       TEXT        NOT NULL DEFAULT 'received',
  raw_event    JSONB       NOT NULL,
  delta_data   JSONB
);

COMMENT ON COLUMN stripe_webhook_events.raw_event IS
  'Full Stripe webhook payload. Access restricted to audit/operator roles. Never log this column.';

-- Billing query pattern: filtering events for a product ordered by arrival time.
CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_product_received
  ON stripe_webhook_events (product_id, received_at);

-- E1 delta pattern: universal_delta_tracker covers BEFORE UPDATE (sets delta_data)
-- and BEFORE DELETE (inserts into delta_log). Consistent with all other HUB tables.
CREATE TRIGGER track_delta_stripe_webhook_events
  BEFORE UPDATE OR DELETE ON stripe_webhook_events
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();
