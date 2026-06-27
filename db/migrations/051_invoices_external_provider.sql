-- Authorized by HUB-1590 (E-BE-1 S7, CR-2) — invoices.external_provider column distinguishes
-- Stripe-webhook-driven invoice rows ('stripe') from HUB-internal credit-mode invoice rows
-- ('internal'). Required by HUB-1556 CR-2: plans with billing_mode='credit' generate invoice
-- records in HUB without any Stripe-side state.
--
-- Renumbered from the spec's 047 (R1 amendment) to 051 because HUB-1704 + HUB-1584 + HUB-1585 +
-- HUB-1586 (3-step) took 045–050. No behavioral change.
--
-- Per R1 FIX: existing rows are backfilled to 'stripe' via the column-add DEFAULT (no separate
-- UPDATE; PostgreSQL 11+ supports adding NOT NULL with constant DEFAULT in one statement
-- without a full table rewrite for the default-value case).

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS external_provider TEXT NOT NULL DEFAULT 'stripe';

ALTER TABLE invoices
  ADD CONSTRAINT invoices_external_provider_check
  CHECK (external_provider IN ('stripe', 'internal'));

COMMENT ON COLUMN invoices.external_provider IS
  'Source-of-truth provider for this invoice row. ''stripe'' = Stripe-webhook-driven invoice with a real stripe_invoice_id; ''internal'' = HUB-internal credit-mode invoice with a synthetic stripe_invoice_id (inv_internal:<uuid>). Downstream reconciliation/webhook handlers MUST NOT look up ''internal'' rows in Stripe. (HUB-1590, CR-2)';
