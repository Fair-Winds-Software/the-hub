-- Authorized by HUB-1680 (E-FE-9 S1) — seed the three tunable thresholds
-- consumed by /admin/customer-health for badge derivation. Values live in
-- the shared `settings` table (migration 005), consistent with HUB-1674's
-- system_health_error_rate_threshold seed pattern (migration 061).
--
-- Defaults:
--   customer_health_red_threshold    — churnRiskScore ≥ this → 'red'
--   customer_health_yellow_threshold — churnRiskScore ≥ this → 'yellow'
--   customer_health_stale_days       — lastActiveAt age gates: >2x → red,
--                                       >1x → yellow

INSERT INTO settings (key, value)
  VALUES ('customer_health_red_threshold', '0.7'::jsonb)
  ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value)
  VALUES ('customer_health_yellow_threshold', '0.4'::jsonb)
  ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value)
  VALUES ('customer_health_stale_days', '14'::jsonb)
  ON CONFLICT (key) DO NOTHING;
