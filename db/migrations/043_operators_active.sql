-- Authorized by HUB-4.1 L2 — Red Team H1: add active flag to operators table for deactivation support
BEGIN;

ALTER TABLE operators
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;

COMMIT;
