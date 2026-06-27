-- Authorized by HUB-1698 (E-BE-1 S21) — SDK version analytics infrastructure.
-- Creates the sdk_versions registry (HUB-maintained metadata per SDK + version) and
-- extends sdk_version_reports with the missing sdk_name dimension required by the
-- E-FE-10 distribution/breakdown/impact endpoints.
--
-- Spec deviation #1 (migration number): R2 D-HUB-SCOPE-036 locked 049 for this story,
-- but 049 was consumed by HUB-1587's role-rename trio (049_role_rename_step2). Using
-- next available number (054) per the established "next-available + document" pattern
-- used for HUB-1697's migration 053.
--
-- Spec deviation #2 (sdk_name column): sdk_version_reports (created in 012) does NOT
-- have an sdk_name column. The analytics service needs to filter reports by sdk_name
-- to power per-SDK distribution. Adding NOT NULL DEFAULT 'hub-sdk' backfills all
-- existing rows to the historical first-party default; new ingest paths can override
-- once we begin reporting synapz-sdk + future SDK identifiers explicitly.

-- ── Registry: one row per (sdk_name, version) ────────────────────────────────
CREATE TABLE IF NOT EXISTS sdk_versions (
  sdk_name    TEXT NOT NULL,
  version     TEXT NOT NULL,
  released_at TIMESTAMPTZ NOT NULL,
  eol_at      TIMESTAMPTZ NULL,
  is_latest   BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (sdk_name, version)
);

CREATE INDEX IF NOT EXISTS sdk_versions_sdk_name_idx ON sdk_versions (sdk_name);
CREATE INDEX IF NOT EXISTS sdk_versions_eol_idx
  ON sdk_versions (sdk_name, eol_at)
  WHERE eol_at IS NOT NULL;

-- ── sdk_version_reports: add sdk_name dimension (HUB-1698 deviation #2) ──────
ALTER TABLE sdk_version_reports
  ADD COLUMN IF NOT EXISTS sdk_name TEXT NOT NULL DEFAULT 'hub-sdk';

CREATE INDEX IF NOT EXISTS sdk_version_reports_sdk_name_idx
  ON sdk_version_reports (sdk_name);

-- ── v0.1 SDK seed (matches FE allowlist in frontend/src/types/sdkRegistry.ts) ─
INSERT INTO sdk_versions (sdk_name, version, released_at, eol_at, is_latest) VALUES
  ('hub-sdk',    '1.0.0', NOW(), NULL, true),
  ('synapz-sdk', '1.0.0', NOW(), NULL, true)
ON CONFLICT DO NOTHING;
