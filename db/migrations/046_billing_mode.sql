-- Authorized by HUB-1584 (E-BE-1 S1, CR-2) — add billing_mode to plans for credit-mode
-- accounting. `billing_mode='credit'` plans suppress all Stripe writes; HUB still generates
-- invoices internally. Consumers ship in S6 (HUB-1589 stripeService guard), S7 (HUB-1590
-- invoiceService), S8 (HUB-1591 planChangeService).
--
-- Renumbered from the spec's 045 to 046 because HUB-1704 (CR-6 auth audit) took the 045
-- slot during the HUB-1555 Story Loop. HUB-1585 / HUB-1586 follow the same +1 shift.
--
-- Rollback (if needed before consumers exist): ALTER TABLE plans DROP COLUMN billing_mode;
-- After S6/S7/S8 ship, rollback becomes a multi-table coordination — prefer feature-flag
-- gating over rollback at that point.

ALTER TABLE plans
  ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'standard'
  CHECK (billing_mode IN ('standard', 'credit'));

COMMENT ON COLUMN plans.billing_mode IS
  'CR-2 (HUB-1556): standard = normal Stripe-billed; credit = HUB-internal accounting, Stripe writes suppressed.';
