-- Authorized by HUB-1750 (E-V2-PP-4 S1, HUB-1728, HUB-1701) — pricing_grandfathers
-- + upgrade_suggestions tables. Per D-HUB-1701-04, pricing_grandfathers is
-- distinct from plan_change_ledger (which handles auto-grandfather-on-archive) and
-- price_overrides (which handles arbitrary per-tenant adjustments). This table
-- stores operator-INTENT policies with policy_type + terms + signed delta_cents.

CREATE TABLE IF NOT EXISTS pricing_grandfathers (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  product_id               UUID        NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  policy_type              TEXT        NOT NULL
                                       CHECK (policy_type IN ('year1_migration_lock','12_month_lock','custom')),
  delta_cents              INTEGER     NOT NULL,
  effective_from           DATE        NOT NULL,
  expires_at               DATE        NOT NULL,
  terms                    TEXT        NOT NULL,
  created_by_operator_id   UUID        NOT NULL,
  reminder_sent_at         TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data               JSONB,
  CONSTRAINT pricing_grandfathers_delta_nonzero CHECK (delta_cents <> 0),
  CONSTRAINT pricing_grandfathers_dates_ordered CHECK (expires_at > effective_from),
  CONSTRAINT pricing_grandfathers_terms_len CHECK (char_length(terms) >= 20),
  CONSTRAINT pricing_grandfathers_start_uq UNIQUE (tenant_id, product_id, effective_from)
);

-- No sparse-active filter (NOW() isn't immutable); callers filter by expires_at > CURRENT_DATE.
CREATE INDEX IF NOT EXISTS idx_pricing_grandfathers_tenant_product_expires
  ON pricing_grandfathers(tenant_id, product_id, expires_at);

CREATE TRIGGER pricing_grandfathers_updated_at
  BEFORE UPDATE ON pricing_grandfathers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER pricing_grandfathers_delta_tracker
  BEFORE UPDATE OR DELETE ON pricing_grandfathers FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

-- ── upgrade_suggestions (rolled into S1 per D-HUB-1701-07) ───────────────────
-- One row per (tenant_id, product_id); upgrade evaluator UPSERTs.
CREATE TABLE IF NOT EXISTS upgrade_suggestions (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id            UUID        NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  suggested_tier_index  INTEGER     NOT NULL CHECK (suggested_tier_index >= 0),
  based_on_period_from  DATE        NOT NULL,
  based_on_period_to    DATE        NOT NULL,
  projected_savings_cents INTEGER   NOT NULL DEFAULT 0,
  computed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dismissed_at          TIMESTAMPTZ,
  cooldown_until        TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data            JSONB,
  CONSTRAINT upgrade_suggestions_uq UNIQUE (tenant_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_upgrade_suggestions_active
  ON upgrade_suggestions(tenant_id, product_id)
  WHERE dismissed_at IS NULL;

CREATE TRIGGER upgrade_suggestions_updated_at
  BEFORE UPDATE ON upgrade_suggestions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER upgrade_suggestions_delta_tracker
  BEFORE UPDATE OR DELETE ON upgrade_suggestions FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();
