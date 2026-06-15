-- Authorized by HUB-566 — add delta tracking and timestamps to price_tiers; add triggers and indexes to pricing_models
-- price_tiers: add delta_data, created_at, updated_at; add set_updated_at + universal_delta_tracker triggers
-- pricing_models: add set_updated_at trigger; add partial active index + activation history index

-- Extend price_tiers with audit columns (migration 004 omitted them)
ALTER TABLE price_tiers
  ADD COLUMN delta_data  JSONB,
  ADD COLUMN created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Auto-stamp updated_at on pricing_models (set_updated_at() defined in 005_settings_table.sql)
CREATE TRIGGER set_updated_at_pricing_models
  BEFORE UPDATE ON pricing_models
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Auto-stamp updated_at on price_tiers
CREATE TRIGGER set_updated_at_price_tiers
  BEFORE UPDATE ON price_tiers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Delta tracking on price_tiers (universal_delta_tracker defined in 002_universal_delta_tracker.sql)
CREATE TRIGGER track_delta_price_tiers
  BEFORE UPDATE OR DELETE ON price_tiers
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

-- Partial index: fast lookup of the single active model per product (E13 activation queries)
CREATE INDEX pricing_models_product_active_idx
  ON pricing_models(product_id)
  WHERE active = true;

-- History index: ordered activation history scans by product
CREATE INDEX pricing_models_product_history_idx
  ON pricing_models(product_id, activated_at DESC NULLS LAST);
