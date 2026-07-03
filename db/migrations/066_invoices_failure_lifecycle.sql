-- Authorized by HUB-1686 (E-FE-13 S1) — invoice failure lifecycle columns
-- for the Failed Payment Tracker (HUB-1568). Adds two orthogonal column
-- groups:
--
--   1. Retry lifecycle — attempt_count, max_attempts, next_retry_at,
--      last_retry_triggered_at. Written by the /retry endpoint + the
--      billing_payment_failed queue processor. Enables the "no double-
--      charge" idempotency check at the API boundary (409 when a retry
--      was triggered within the last 30 seconds).
--
--   2. Override state — overridden_at, overridden_by, override_reason.
--      Written by the /override endpoint. Never a hard delete per
--      Ironclad Interface invariant 1 — the row stays visible in the
--      list with a distinct 'overridden' badge.
--
-- Derivation contract for the FE-visible hub_state ('pending_retry' |
-- 'exhausted' | 'recovered' | 'overridden') lives in the read query in
-- src/routes/admin/failedPayments.ts — computed from these columns +
-- the existing invoices.payment_failed_at / amount_paid / amount_due
-- fields. No stored hub_state column: state derivation stays in one
-- place (the SELECT) so we can't diverge between INSERT + UPDATE paths.

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS attempt_count             INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts              INTEGER     NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS next_retry_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_retry_triggered_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS overridden_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS overridden_by             TEXT,
  ADD COLUMN IF NOT EXISTS override_reason           TEXT;

-- Index for the hot read path — /admin/billing/failed-payments filters
-- by payment_failed_at recency + optional productId + optional
-- (derived) status. This partial index covers the "list failures in
-- the last 30d" query cheaply while keeping the on-disk footprint
-- small for the (majority) non-failed rows.
CREATE INDEX IF NOT EXISTS idx_invoices_payment_failed_recent
  ON invoices (payment_failed_at DESC)
  WHERE payment_failed_at IS NOT NULL;

-- Length gate for override_reason enforced at the app layer (route
-- validator returns 422 if <20 chars). CHECK constraint left off
-- deliberately so historical rows without an override_reason don't
-- blow up the constraint on a future ALTER.
