-- Authorized by HUB-1791 (S2 of HUB-1783 — Generalize the connections framework) — rename
-- the S8/HUB-1781 legacy setting key `stripe_connection_mode` to the generic
-- `connection_mode.stripe` shape used by the multi-connection registry.
--
-- Idempotent: safe to re-run. If the legacy key doesn't exist (fresh DB), the migration is
-- a no-op. If the new key already exists (upgraded DB), we do nothing — we do NOT overwrite
-- an already-migrated setting.

DO $$
DECLARE
  legacy_value JSONB;
BEGIN
  -- Only migrate when legacy exists AND new is absent.
  SELECT value INTO legacy_value
    FROM settings
   WHERE key = 'stripe_connection_mode';

  IF FOUND AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'connection_mode.stripe') THEN
    INSERT INTO settings (key, value)
    VALUES ('connection_mode.stripe', legacy_value);

    DELETE FROM settings WHERE key = 'stripe_connection_mode';
  END IF;
END $$;
