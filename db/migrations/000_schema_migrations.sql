-- Authorized by HUB-49 — schema_migrations bootstrap table
-- Safe to apply multiple times due to IF NOT EXISTS; the runner also bootstraps
-- this table inline before reading SQL files, so this file is always a no-op.
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   TEXT        PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
