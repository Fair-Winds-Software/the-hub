-- Authorized by HUB-1479 — discounts, tenant_discounts, customer_credits, price_overrides tables
-- Authorized by HUB-1485 — delta tracking on all mutable tables; customer_credits immutability trigger

-- Discount catalog definitions (product-scoped; backed by Stripe coupons)
CREATE TABLE IF NOT EXISTS discounts (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id          UUID        NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  name                TEXT        NOT NULL,
  discount_type       TEXT        NOT NULL CHECK (discount_type IN ('percent', 'amount')),
  value               NUMERIC     NOT NULL,
  currency            TEXT        NOT NULL DEFAULT 'usd',
  duration            TEXT        NOT NULL CHECK (duration IN ('once', 'repeating', 'forever')),
  duration_in_months  INT,
  stripe_coupon_id    TEXT        UNIQUE,
  active              BOOLEAN     NOT NULL DEFAULT true,
  created_by          TEXT,
  delta_data          JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (product_id, name)
);

CREATE INDEX IF NOT EXISTS idx_discounts_product_id ON discounts (product_id);

CREATE OR REPLACE TRIGGER discounts_updated_at
  BEFORE UPDATE ON discounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER discounts_delta_tracker
  BEFORE UPDATE OR DELETE ON discounts
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

-- Per-tenant discount applications (no UNIQUE constraint: allows re-apply after removal)
CREATE TABLE IF NOT EXISTS tenant_discounts (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id          UUID        NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  discount_id         UUID        NOT NULL REFERENCES discounts(id) ON DELETE RESTRICT,
  stripe_discount_id  TEXT,
  applied_at          TIMESTAMPTZ NOT NULL,
  removed_at          TIMESTAMPTZ,
  applied_by          TEXT,
  delta_data          JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenant_discounts_tenant_product
  ON tenant_discounts (tenant_id, product_id);

CREATE OR REPLACE TRIGGER tenant_discounts_delta_tracker
  BEFORE UPDATE OR DELETE ON tenant_discounts
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

-- Customer credits ledger (INSERT-only; immutable at DB level for AUDIT-003)
-- customer_credits: INSERT-only table. immutability trigger fires before delta tracker
-- on UPDATE/DELETE; delta_data not added to this table by design.
CREATE TABLE IF NOT EXISTS customer_credits (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id                UUID        REFERENCES products(id) ON DELETE RESTRICT,
  credit_amount_cents       BIGINT      NOT NULL,
  currency                  TEXT        NOT NULL DEFAULT 'usd',
  description               TEXT        NOT NULL,
  accounting_period         TEXT        NOT NULL CHECK (accounting_period ~ '^\d{4}-\d{2}$'),
  stripe_balance_applied    BOOLEAN     NOT NULL DEFAULT false,
  stripe_balance_applied_at TIMESTAMPTZ,
  stripe_balance_txn_id     TEXT,
  created_by                TEXT        NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_credits_tenant_id
  ON customer_credits (tenant_id);

-- DB-level immutability guard: accounting ledger rows cannot be modified or deleted
CREATE OR REPLACE FUNCTION customer_credits_immutable_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'customer_credits is immutable — use a reversal entry instead';
END;
$$;

CREATE OR REPLACE TRIGGER customer_credits_immutable
  BEFORE UPDATE OR DELETE ON customer_credits
  FOR EACH ROW EXECUTE FUNCTION customer_credits_immutable_guard();

-- Price overrides per tenant+plan (effective-dated per SCHEMA-021; no active flag; no updated_at)
CREATE TABLE IF NOT EXISTS price_overrides (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id            UUID        NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  plan_id               UUID        NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  override_price_cents  BIGINT      NOT NULL,
  effective_from        TIMESTAMPTZ NOT NULL,
  effective_to          TIMESTAMPTZ,
  reason                TEXT        NOT NULL,
  applied_by            TEXT        NOT NULL,
  delta_data            JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_price_overrides_tenant_product_plan
  ON price_overrides (tenant_id, product_id, plan_id);

CREATE INDEX IF NOT EXISTS idx_price_overrides_effective_range
  ON price_overrides (effective_from, effective_to);

CREATE OR REPLACE TRIGGER price_overrides_delta_tracker
  BEFORE UPDATE OR DELETE ON price_overrides
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();
