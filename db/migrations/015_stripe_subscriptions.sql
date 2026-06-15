-- Authorized by HUB-412 — stripe_subscriptions table: one subscription per (tenant, product) pair (D-005)
CREATE TABLE IF NOT EXISTS stripe_subscriptions (
  id                      UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id              UUID          NOT NULL,
  stripe_subscription_id  VARCHAR(255)  UNIQUE NOT NULL,
  stripe_price_id         VARCHAR(255)  NOT NULL,
  status                  VARCHAR(50)   NOT NULL,
  current_period_start    TIMESTAMPTZ   NOT NULL,
  current_period_end      TIMESTAMPTZ   NOT NULL,
  cancel_at_period_end    BOOLEAN       NOT NULL DEFAULT false,
  cancelled_at            TIMESTAMPTZ,
  delta_data              JSONB,
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, product_id)
);
CREATE INDEX idx_stripe_subscriptions_tenant_id ON stripe_subscriptions(tenant_id);
CREATE TRIGGER stripe_subscriptions_updated_at
  BEFORE UPDATE ON stripe_subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER stripe_subscriptions_delta_tracker
  BEFORE UPDATE OR DELETE ON stripe_subscriptions
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();
