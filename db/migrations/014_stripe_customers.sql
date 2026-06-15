-- Authorized by HUB-412 — stripe_customers table: one-to-one tenant → Stripe customer mapping; delta tracking
CREATE TABLE IF NOT EXISTS stripe_customers (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID          UNIQUE NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  stripe_customer_id  VARCHAR(255)  UNIQUE NOT NULL,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  delta_data          JSONB
);
CREATE TRIGGER stripe_customers_updated_at
  BEFORE UPDATE ON stripe_customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER stripe_customers_delta_tracker
  BEFORE UPDATE OR DELETE ON stripe_customers
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();
