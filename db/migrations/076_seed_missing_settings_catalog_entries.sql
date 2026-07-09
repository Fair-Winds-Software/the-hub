-- Authorized by HUB-1770 — /harden hygiene follow-up. Two settings catalog entries were
-- added to src/types/settingsCatalog.ts (jira_project_key_by_product via HUB-1592;
-- pricing_elasticity_coefficient via HUB-1660) but never seeded via a migration companion
-- to 047. settingsCatalogSeeds.integration.test.ts iterates SETTINGS_CATALOG and asserts
-- every key is present in `settings` — it caught the drift. Idempotent via
-- ON CONFLICT DO NOTHING so operator-tuned values are preserved.

INSERT INTO settings (key, value)
VALUES
  ('jira_project_key_by_product',
    '{"contenthelm":"CH","hub":"HUB","synapz":"SYNC","launchkit":"LK"}'::jsonb),
  ('pricing_elasticity_coefficient', '-1.0'::jsonb)
ON CONFLICT (key) DO NOTHING;
