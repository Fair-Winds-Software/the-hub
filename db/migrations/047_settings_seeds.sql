-- Authorized by HUB-1585 (E-BE-1 S2, CR-3 + CR-5) — seed v0.1 settings catalog rows
-- consumed by HUB-1556 BE CRs and HUB-1559/60/66/67 FE Epics. ON CONFLICT (key) DO NOTHING
-- so re-runs (and operator-tuned values via HUB-1664 HUB Settings editor) are preserved.
--
-- Renumbered from the spec's 046 to 047 because HUB-1704 took 045 and HUB-1584 took 046.
-- HUB-1586 (3-step role rename migrations) follows at 048/049/050.
--
-- Schema reality vs spec: the live `settings` table (migration 005, HUB-126) has columns
-- (key, value JSONB) — NOT the R-amendment's referenced `value_type` column. Each value is
-- stored as a JSONB scalar; the type contract is owned by `src/types/settingsCatalog.ts`.
--
-- Catalog (R5 final — 8 keys):
--   portfolio_margin_threshold_pct      = 0.0   (CR-3, HUB-1595)
--   role_rename_compat_window_enabled   = true  (CR-4, HUB-1588 reads + flips)
--   compliance_drift_threshold_pct      = 10.0  (HUB-1622 / HUB-1625, E-FE-8)
--   sdk_stale_threshold_days            = 30    (HUB-1633 / HUB-1698, E-FE-10 / E-BE-1)
--   system_health_error_rate_threshold  = 0.05  (HUB-1566 R4, E-FE-7)
--   customer_health_red_threshold       = 0.7   (HUB-1680, E-FE-9)
--   customer_health_yellow_threshold    = 0.4   (HUB-1680, E-FE-9)
--   customer_health_stale_days          = 14    (HUB-1680, E-FE-9)
--
-- Drop note: `pricing_elasticity_coefficient` (original AC#1) was implicitly removed
-- between R2 and R5 — none of the cumulative catalog tables include it. HUB-1597
-- (S14 analyticsService.computePricingScenario) consumer must default the elasticity
-- coefficient in code (e.g., constant -1.0) until a future seed re-adds it.

INSERT INTO settings (key, value)
VALUES
  ('portfolio_margin_threshold_pct',      '0.0'::jsonb),
  ('role_rename_compat_window_enabled',   'true'::jsonb),
  ('compliance_drift_threshold_pct',      '10.0'::jsonb),
  ('sdk_stale_threshold_days',            '30'::jsonb),
  ('system_health_error_rate_threshold',  '0.05'::jsonb),
  ('customer_health_red_threshold',       '0.7'::jsonb),
  ('customer_health_yellow_threshold',    '0.4'::jsonb),
  ('customer_health_stale_days',          '14'::jsonb)
ON CONFLICT (key) DO NOTHING;
