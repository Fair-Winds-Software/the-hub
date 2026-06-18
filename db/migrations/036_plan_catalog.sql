-- Authorized by HUB-1465 — plans + plan_archive_ledger tables; stripe_product_id cached on products

ALTER TABLE products ADD COLUMN IF NOT EXISTS stripe_product_id TEXT;

CREATE TABLE IF NOT EXISTS plans (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id        UUID        NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  key               TEXT        NOT NULL,
  name              TEXT        NOT NULL,
  description       TEXT,
  billing_type      TEXT        NOT NULL CHECK (billing_type IN ('flat_rate','per_seat','metered','tiered','one_time')),
  billing_interval  TEXT        CHECK (billing_interval IN ('month','quarter','year','one_time')),
  unit_amount_cents BIGINT,
  tiers             JSONB,
  stripe_product_id TEXT        NOT NULL,
  stripe_price_id   TEXT        UNIQUE NOT NULL,
  entitlements      JSONB       NOT NULL DEFAULT '{}',
  active            BOOLEAN     NOT NULL DEFAULT false,
  metadata          JSONB,
  delta_data        JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (product_id, key)
);

CREATE INDEX IF NOT EXISTS idx_plans_product_id ON plans(product_id);
CREATE INDEX IF NOT EXISTS idx_plans_stripe_price_id ON plans(stripe_price_id);

CREATE TRIGGER plans_updated_at
  BEFORE UPDATE ON plans FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER plans_delta_tracker
  BEFORE UPDATE OR DELETE ON plans FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

CREATE TABLE IF NOT EXISTS plan_archive_ledger (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id                  UUID        NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  archived_at              TIMESTAMPTZ NOT NULL,
  reason                   TEXT,
  archived_by              TEXT,
  previous_stripe_price_id TEXT        NOT NULL,
  delta_data               JSONB,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plan_archive_ledger_plan_id ON plan_archive_ledger(plan_id);

CREATE TRIGGER plan_archive_ledger_delta_tracker
  BEFORE UPDATE OR DELETE ON plan_archive_ledger FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();
