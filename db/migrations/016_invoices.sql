-- Authorized by HUB-461 — invoices + invoice_items tables; per-product invoice storage with delta tracking
CREATE TABLE IF NOT EXISTS invoices (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id            UUID          NOT NULL,
  stripe_invoice_id     VARCHAR(255)  NOT NULL UNIQUE,
  stripe_subscription_id VARCHAR(255) NOT NULL,
  status                VARCHAR(50)   NOT NULL,
  amount_due            INTEGER       NOT NULL,
  amount_paid           INTEGER       NOT NULL DEFAULT 0,
  currency              VARCHAR(3)    NOT NULL,
  period_start          TIMESTAMPTZ   NOT NULL,
  period_end            TIMESTAMPTZ   NOT NULL,
  invoice_pdf_url       TEXT,
  payment_failed_at     TIMESTAMPTZ,
  delta_data            JSONB,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS invoices_tenant_product_period_idx ON invoices (tenant_id, product_id, period_start DESC);
CREATE TRIGGER invoices_updated_at
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER invoices_delta_tracker
  BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

CREATE TABLE IF NOT EXISTS invoice_items (
  id                       UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id               UUID          NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  stripe_invoice_item_id   VARCHAR(255)  NOT NULL UNIQUE,
  description              TEXT,
  amount                   INTEGER       NOT NULL,
  quantity                 INTEGER       NOT NULL DEFAULT 1,
  stripe_price_id          VARCHAR(255)  NOT NULL,
  delta_data               JSONB,
  created_at               TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE TRIGGER invoice_items_updated_at
  BEFORE UPDATE ON invoice_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER invoice_items_delta_tracker
  BEFORE UPDATE OR DELETE ON invoice_items
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();
