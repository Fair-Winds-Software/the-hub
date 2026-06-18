-- Authorized by HUB-1470 — add plan_id FK to stripe_subscriptions for BILL-004 traceability

ALTER TABLE stripe_subscriptions ADD COLUMN IF NOT EXISTS plan_id UUID REFERENCES plans(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_stripe_subscriptions_plan_id ON stripe_subscriptions(plan_id);
