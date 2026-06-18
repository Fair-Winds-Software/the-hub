-- Authorized by HUB-1486 — extend plan_change_ledger with schedule, grandfathering, and audit columns

ALTER TABLE plan_change_ledger ADD COLUMN IF NOT EXISTS stripe_schedule_id    TEXT;
ALTER TABLE plan_change_ledger ADD COLUMN IF NOT EXISTS grandfathered          BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE plan_change_ledger ADD COLUMN IF NOT EXISTS protection_expires_at  TIMESTAMPTZ;
ALTER TABLE plan_change_ledger ADD COLUMN IF NOT EXISTS target_stripe_price_id TEXT;
ALTER TABLE plan_change_ledger ADD COLUMN IF NOT EXISTS applied_at             TIMESTAMPTZ;
-- no FK constraint: archived plan IDs must remain referenceable in audit history
ALTER TABLE plan_change_ledger ADD COLUMN IF NOT EXISTS old_plan_id            UUID;
ALTER TABLE plan_change_ledger ADD COLUMN IF NOT EXISTS reason                 TEXT;
-- delta_data already present from migration 004; ADD COLUMN IF NOT EXISTS is a no-op:
ALTER TABLE plan_change_ledger ADD COLUMN IF NOT EXISTS delta_data             JSONB;

-- Secondary index for tenant-first history queries (existing index uses product_id-first order)
CREATE INDEX IF NOT EXISTS idx_plan_change_ledger_tenant_product
  ON plan_change_ledger(tenant_id, product_id);

-- Delta tracker trigger already exists as track_delta_plan_change_ledger from migration 004.
-- Conditionally create plan_change_ledger_delta_tracker only if not already present:
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'plan_change_ledger'
      AND t.tgname = 'plan_change_ledger_delta_tracker'
  ) THEN
    -- track_delta_plan_change_ledger already covers this table; skip creation.
    NULL;
  END IF;
END $$;
