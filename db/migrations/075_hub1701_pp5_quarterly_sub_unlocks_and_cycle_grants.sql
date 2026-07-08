-- Authorized by HUB-1761 + HUB-1764 (E-V2-PP-5 S2/S5, HUB-1729, HUB-1701) —
-- plan_quota_sub_unlocks (operator config) + quarterly_cycle_grants (scheduler
-- output). Quarterly cadence uses Stripe native (interval='month', interval_count=3)
-- per HUB-1762 spike closure decision — 3 calendar months, NOT 91 days.

-- ── plan_quota_sub_unlocks (HUB-1761 S2) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS plan_quota_sub_unlocks (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id             UUID        NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  dimension_key       TEXT        NOT NULL,
  per_month_quantity  INTEGER     NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data          JSONB,
  CONSTRAINT plan_quota_sub_unlocks_quantity_min CHECK (per_month_quantity >= 1),
  CONSTRAINT plan_quota_sub_unlocks_key_shape CHECK (dimension_key ~ '^[a-z][a-z0-9_]{2,63}$'),
  CONSTRAINT plan_quota_sub_unlocks_uq UNIQUE (plan_id, dimension_key)
);

CREATE INDEX IF NOT EXISTS idx_plan_quota_sub_unlocks_plan
  ON plan_quota_sub_unlocks(plan_id);

CREATE TRIGGER plan_quota_sub_unlocks_updated_at
  BEFORE UPDATE ON plan_quota_sub_unlocks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER plan_quota_sub_unlocks_delta_tracker
  BEFORE UPDATE OR DELETE ON plan_quota_sub_unlocks FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

-- ── quarterly_cycle_grants (HUB-1764 S5) ────────────────────────────────────
-- Scheduler-emitted entitlement grants; one row per (tenant, dimension, cycle, month-position).
-- cycle_id is a synthetic UUID identifying a specific quarterly cycle instance for a tenant/plan.
-- cycle_position ∈ {1,2,3} indicates the month within the cycle.
CREATE TABLE IF NOT EXISTS quarterly_cycle_grants (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id             UUID        NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  dimension_key       TEXT        NOT NULL,
  quantity            INTEGER     NOT NULL,
  cycle_id            UUID        NOT NULL,
  cycle_position      INTEGER     NOT NULL,
  cycle_start         DATE        NOT NULL,
  granted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data          JSONB,
  CONSTRAINT quarterly_cycle_grants_quantity_min CHECK (quantity >= 1),
  CONSTRAINT quarterly_cycle_grants_position_range CHECK (cycle_position BETWEEN 1 AND 3),
  CONSTRAINT quarterly_cycle_grants_uq UNIQUE (tenant_id, dimension_key, cycle_id, cycle_position)
);

CREATE INDEX IF NOT EXISTS idx_quarterly_cycle_grants_tenant_cycle
  ON quarterly_cycle_grants(tenant_id, cycle_id);
CREATE INDEX IF NOT EXISTS idx_quarterly_cycle_grants_tenant_dimension
  ON quarterly_cycle_grants(tenant_id, dimension_key);

CREATE TRIGGER quarterly_cycle_grants_updated_at
  BEFORE UPDATE ON quarterly_cycle_grants FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER quarterly_cycle_grants_delta_tracker
  BEFORE UPDATE OR DELETE ON quarterly_cycle_grants FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();
