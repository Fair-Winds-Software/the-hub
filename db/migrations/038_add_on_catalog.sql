-- Authorized by HUB-1472 — add_ons + tenant_add_ons tables; partial unique index for re-activation

-- Add-on catalog definitions (operator-managed; billing_type: recurring | one_time)
CREATE TABLE IF NOT EXISTS add_ons (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id          UUID        NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  key                 TEXT        NOT NULL,
  name                TEXT        NOT NULL,
  description         TEXT,
  billing_type        TEXT        NOT NULL CHECK (billing_type IN ('recurring', 'one_time')),
  billing_interval    TEXT        CHECK (billing_interval IN ('month', 'quarter', 'year', 'one_time')),
  unit_amount_cents   BIGINT      NOT NULL,
  stripe_price_id     TEXT        UNIQUE NOT NULL,
  active              BOOLEAN     NOT NULL DEFAULT false,
  metadata            JSONB,
  delta_data          JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (product_id, key)
);

CREATE INDEX IF NOT EXISTS idx_add_ons_product_id ON add_ons (product_id);

CREATE OR REPLACE TRIGGER add_ons_updated_at
  BEFORE UPDATE ON add_ons
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER add_ons_delta_tracker
  BEFORE UPDATE OR DELETE ON add_ons
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

-- Per-tenant add-on activation records
-- No updated_at: status transitions captured via delta_data + cancelled_at (append-like lifecycle)
CREATE TABLE IF NOT EXISTS tenant_add_ons (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id                  UUID        NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  add_on_id                   UUID        NOT NULL REFERENCES add_ons(id) ON DELETE RESTRICT,
  stripe_subscription_item_id TEXT,
  quantity                    INT         NOT NULL DEFAULT 1,
  status                      TEXT        NOT NULL CHECK (status IN ('active', 'cancelled')),
  activated_at                TIMESTAMPTZ NOT NULL,
  cancelled_at                TIMESTAMPTZ,
  delta_data                  JSONB,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partial unique index: allows cancelled historical rows; prevents duplicate active add-ons
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_add_ons_active_unique
  ON tenant_add_ons (tenant_id, product_id, add_on_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_tenant_add_ons_tenant_product
  ON tenant_add_ons (tenant_id, product_id);

CREATE INDEX IF NOT EXISTS idx_tenant_add_ons_status
  ON tenant_add_ons (status);

CREATE OR REPLACE TRIGGER tenant_add_ons_delta_tracker
  BEFORE UPDATE OR DELETE ON tenant_add_ons
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();
