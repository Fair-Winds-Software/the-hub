-- Authorized by HUB-1592 (E-BE-1 S9, CR-1) — seed settings row jira_project_key_by_product.
-- This is the HUB-product-key → Atlassian-project-key map consumed by HUB-1593
-- jiraIntegrationService at request time. Operator can update via the Settings UI
-- (HUB-1664) without code change.
--
-- Renumbered from spec's 05X to 052 (045–051 already taken).
-- Schema: live table is `settings` (HUB-126 migration 005), value stored as JSONB scalar.

INSERT INTO settings (key, value)
VALUES (
  'jira_project_key_by_product',
  '{"contenthelm":"CH","hub":"HUB","synapz":"SYNC","launchkit":"LK"}'::jsonb
)
ON CONFLICT (key) DO NOTHING;
