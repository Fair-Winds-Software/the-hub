-- Authorized by HUB-1715 + HUB-1716 + HUB-1717 (E-V2-PP-1 S2/S3/S4, HUB-1713, HUB-1701) —
-- LaunchKit pricing primitives: volume-ladder JSONB extension, per-plan first-N-free
-- quantity metering, and platform-target bundle-discount table.
--
-- Design decisions per D-HUB-1701-02 (Reconciliation Log 2026-07-07):
--   - Volume ladder is a JSONB column on `plans` (not a normalized table), matching
--     the existing `plans.tiers JSONB` shape from migration 036. Shape:
--       plans.volume_ladder = [{ min_quantity, max_quantity, unit_amount_cents, sort_order }, ...]
--     min_quantity >= 1, max_quantity is NULL for the "and above" open-ended row.
--   - first_n_free_quantity + quantity_metered_dimension are additive nullable-friendly
--     columns on `plans`. Cross-field integrity (first_n_free > 0 requires dimension set)
--     is validated at API layer per HUB-1716 AC 5.
--   - plan_bundles is a new normalized table because bundles cross plan references —
--     nested JSONB with UUID FKs into an array can't be enforced by the DB.

-- ── plans column extensions (S2 volume_ladder + S3 first_n_free + metered_dimension) ──
ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS volume_ladder             JSONB;

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS first_n_free_quantity     INTEGER NOT NULL DEFAULT 0;

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS quantity_metered_dimension TEXT;

-- CHECK: first_n_free_quantity is non-negative (S3 AC 2).
ALTER TABLE plans
  ADD CONSTRAINT plans_first_n_free_nonneg
    CHECK (first_n_free_quantity >= 0);

-- CHECK: quantity_metered_dimension matches the shared snake_case discipline used
-- across E-V2-PP-3 (dimension_key regex). Nullable; validated only when non-null.
ALTER TABLE plans
  ADD CONSTRAINT plans_quantity_metered_dimension_key
    CHECK (
      quantity_metered_dimension IS NULL
      OR quantity_metered_dimension ~ '^[a-z][a-z0-9_]{2,63}$'
    );

-- ── plan_bundles (S4) ─────────────────────────────────────────────────────────
-- Bundle discount when member plans are simultaneously present in a cart.
-- Enforced FK integrity on member_plan_ids via BEFORE INSERT/UPDATE trigger since PG
-- arrays don't support declarative FKs.
CREATE TABLE IF NOT EXISTS plan_bundles (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id       UUID        NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  bundle_name      TEXT        NOT NULL,
  member_plan_ids  UUID[]      NOT NULL,
  discount_type    TEXT        NOT NULL
                               CHECK (discount_type IN ('flat_amount_cents','percent_bps')),
  discount_value   INTEGER     NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active','archived')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data       JSONB,
  CONSTRAINT plan_bundles_member_count_ge2
    CHECK (array_length(member_plan_ids, 1) >= 2),
  CONSTRAINT plan_bundles_discount_value_nonneg
    CHECK (discount_value >= 0),
  CONSTRAINT plan_bundles_percent_bps_max
    CHECK (discount_type <> 'percent_bps' OR discount_value <= 10000),
  CONSTRAINT plan_bundles_name_uq_per_product
    UNIQUE (product_id, bundle_name)
);

CREATE INDEX IF NOT EXISTS idx_plan_bundles_product_status
  ON plan_bundles(product_id, status);
CREATE INDEX IF NOT EXISTS idx_plan_bundles_member_plan_ids
  ON plan_bundles USING GIN (member_plan_ids);

CREATE TRIGGER plan_bundles_updated_at
  BEFORE UPDATE ON plan_bundles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER plan_bundles_delta_tracker
  BEFORE UPDATE OR DELETE ON plan_bundles FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

-- FK integrity trigger — each member_plan_id must reference an existing plan whose
-- product_id matches the bundle's product_id. Violations raise 23503 (fk_violation)
-- per S4 AC 4.
CREATE OR REPLACE FUNCTION plan_bundles_validate_members()
RETURNS TRIGGER AS $$
DECLARE
  missing_id UUID;
  wrong_product_id UUID;
BEGIN
  -- Any member plan missing entirely?
  SELECT m INTO missing_id
    FROM unnest(NEW.member_plan_ids) AS m
   WHERE NOT EXISTS (SELECT 1 FROM plans p WHERE p.id = m);
  IF missing_id IS NOT NULL THEN
    RAISE EXCEPTION 'plan_bundles.member_plan_ids references nonexistent plan %', missing_id
      USING ERRCODE = '23503';
  END IF;

  -- Any member plan bound to a different product than the bundle?
  SELECT p.id INTO wrong_product_id
    FROM plans p
   WHERE p.id = ANY(NEW.member_plan_ids)
     AND p.product_id <> NEW.product_id
   LIMIT 1;
  IF wrong_product_id IS NOT NULL THEN
    RAISE EXCEPTION 'plan_bundles.member_plan_ids includes plan % from a different product', wrong_product_id
      USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER plan_bundles_validate_members_ins_upd
  BEFORE INSERT OR UPDATE OF member_plan_ids, product_id ON plan_bundles
  FOR EACH ROW EXECUTE FUNCTION plan_bundles_validate_members();
