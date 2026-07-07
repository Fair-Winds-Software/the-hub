-- Authorized by HUB-1730 + HUB-1731 + HUB-1732 (E-V2-PP-2 S1/S2/S3, HUB-1726, HUB-1701) —
-- Custom-Quote Workflow schemas: quote headers + immutable line items (after approval) +
-- immutable audit-chain approvals with two-role attestation invariant.
--
-- Three tables land here:
--   custom_quotes            (mutable header; delta_data + universal_delta_tracker)
--   custom_quote_line_items  (mutable while quote.status='draft'; immutable once
--                             quote.status IN ('pending','approved','rejected','expired'))
--   custom_quote_approvals   (fully immutable + content_hash SHA-256)
--
-- pgcrypto already loaded by migration 067. universal_delta_tracker + set_updated_at
-- already loaded by earlier migrations.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── custom_quotes header ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS custom_quotes (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  product_id       UUID        NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  operator_id      UUID        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'draft'
                               CHECK (status IN ('draft','pending','approved','rejected','expired')),
  total_cents      INTEGER     NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  currency         CHAR(3)     NOT NULL DEFAULT 'USD',
  expires_at       TIMESTAMPTZ NOT NULL,
  decision_reason  TEXT,
  invoice_id       UUID,  -- Populated by S6 pipeline once attached to an invoice.
  invoiced_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data       JSONB,
  CONSTRAINT custom_quotes_decision_reason_when_final
    CHECK (
      (status NOT IN ('rejected','expired'))
      OR (decision_reason IS NOT NULL AND char_length(decision_reason) >= 20)
    )
);
CREATE INDEX IF NOT EXISTS idx_custom_quotes_tenant_status
  ON custom_quotes(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_custom_quotes_expires_at
  ON custom_quotes(expires_at) WHERE status IN ('draft','pending');

CREATE TRIGGER custom_quotes_updated_at
  BEFORE UPDATE ON custom_quotes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER custom_quotes_delta_tracker
  BEFORE UPDATE OR DELETE ON custom_quotes FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

-- Illegal-transition guard per S1 AC 3: `draft` → `approved` direct is not allowed.
-- Approval always requires an explicit approval endpoint (S5).
CREATE OR REPLACE FUNCTION custom_quotes_guard_transitions()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'draft' AND NEW.status = 'approved' THEN
    RAISE EXCEPTION 'custom_quotes: cannot transition draft → approved directly; must go through pending'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('approved','rejected','expired') AND NEW.status != OLD.status THEN
    RAISE EXCEPTION 'custom_quotes: terminal status % cannot transition', OLD.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER custom_quotes_guard_transitions_trg
  BEFORE UPDATE OF status ON custom_quotes
  FOR EACH ROW EXECUTE FUNCTION custom_quotes_guard_transitions();

-- ── custom_quote_line_items ─────────────────────────────────────────────────
-- plan_id is nullable — line items can be free-form (description + qty + amount) OR
-- reference an existing plan (open Discovery Q2 default: allow both).
CREATE TABLE IF NOT EXISTS custom_quote_line_items (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id          UUID        NOT NULL REFERENCES custom_quotes(id) ON DELETE CASCADE,
  plan_id           UUID        REFERENCES plans(id) ON DELETE RESTRICT,
  description       TEXT        NOT NULL,
  quantity          INTEGER     NOT NULL CHECK (quantity >= 1),
  unit_amount_cents INTEGER     NOT NULL CHECK (unit_amount_cents >= 0),
  metadata          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  sort_order        INTEGER     NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data        JSONB
);
CREATE INDEX IF NOT EXISTS idx_custom_quote_line_items_quote
  ON custom_quote_line_items(quote_id, sort_order);

CREATE TRIGGER custom_quote_line_items_delta_tracker
  BEFORE UPDATE OR DELETE ON custom_quote_line_items FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

-- Cross-scope integrity: plan_id (when set) must belong to the quote's product_id.
CREATE OR REPLACE FUNCTION custom_quote_line_items_validate_plan()
RETURNS TRIGGER AS $$
DECLARE
  q_product UUID;
  p_product UUID;
BEGIN
  IF NEW.plan_id IS NULL THEN RETURN NEW; END IF;
  SELECT product_id INTO q_product FROM custom_quotes WHERE id = NEW.quote_id;
  SELECT product_id INTO p_product FROM plans WHERE id = NEW.plan_id;
  IF q_product IS NULL THEN
    RAISE EXCEPTION 'custom_quote_line_items: quote_id % not found', NEW.quote_id USING ERRCODE = '23503';
  END IF;
  IF p_product IS NULL THEN
    RAISE EXCEPTION 'custom_quote_line_items: plan_id % not found', NEW.plan_id USING ERRCODE = '23503';
  END IF;
  IF q_product != p_product THEN
    RAISE EXCEPTION 'custom_quote_line_items: plan % belongs to product % but quote is for product %',
      NEW.plan_id, p_product, q_product USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER custom_quote_line_items_validate_plan_ins_upd
  BEFORE INSERT OR UPDATE OF plan_id, quote_id ON custom_quote_line_items
  FOR EACH ROW EXECUTE FUNCTION custom_quote_line_items_validate_plan();

-- Immutability guard: line items become immutable once parent quote leaves 'draft'.
CREATE OR REPLACE FUNCTION custom_quote_line_items_immutable_after_draft()
RETURNS TRIGGER AS $$
DECLARE
  q_status TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO q_status FROM custom_quotes WHERE id = NEW.quote_id;
  ELSE
    SELECT status INTO q_status FROM custom_quotes WHERE id = OLD.quote_id;
  END IF;
  IF q_status IS NOT NULL AND q_status != 'draft' THEN
    RAISE EXCEPTION 'custom_quote_line_items: cannot modify line items when parent quote is %', q_status
      USING ERRCODE = '23514';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER custom_quote_line_items_immutable_after_draft_trg
  BEFORE INSERT OR UPDATE OR DELETE ON custom_quote_line_items
  FOR EACH ROW EXECUTE FUNCTION custom_quote_line_items_immutable_after_draft();

-- Sum-into-total: keep custom_quotes.total_cents authoritative from child rows.
CREATE OR REPLACE FUNCTION custom_quote_line_items_recompute_total()
RETURNS TRIGGER AS $$
DECLARE
  target_quote UUID;
  new_total    INTEGER;
BEGIN
  target_quote := COALESCE(NEW.quote_id, OLD.quote_id);
  SELECT COALESCE(SUM(quantity * unit_amount_cents), 0)::INTEGER INTO new_total
    FROM custom_quote_line_items
   WHERE quote_id = target_quote;
  -- The direct UPDATE below fires custom_quotes_guard_transitions_trg, but that
  -- trigger only fires on status changes (BEFORE UPDATE OF status). Since we only
  -- touch total_cents + updated_at, the guard does not fire.
  UPDATE custom_quotes SET total_cents = new_total, updated_at = NOW()
   WHERE id = target_quote;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER custom_quote_line_items_recompute_total_trg
  AFTER INSERT OR UPDATE OR DELETE ON custom_quote_line_items
  FOR EACH ROW EXECUTE FUNCTION custom_quote_line_items_recompute_total();

-- ── custom_quote_approvals (immutable audit chain) ──────────────────────────
CREATE TABLE IF NOT EXISTS custom_quote_approvals (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id              UUID        NOT NULL REFERENCES custom_quotes(id) ON DELETE RESTRICT,
  approver_operator_id  UUID        NOT NULL,
  decision              TEXT        NOT NULL CHECK (decision IN ('approved','rejected')),
  reason                TEXT        NOT NULL CHECK (char_length(reason) >= 20),
  content_hash          TEXT        NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_custom_quote_approvals_quote
  ON custom_quote_approvals(quote_id, created_at DESC);

-- BEFORE INSERT: compute content_hash + assert two-role attestation (creator ≠ approver).
CREATE OR REPLACE FUNCTION custom_quote_approvals_before_insert()
RETURNS TRIGGER AS $$
DECLARE
  creator_id UUID;
BEGIN
  SELECT operator_id INTO creator_id FROM custom_quotes WHERE id = NEW.quote_id;
  IF creator_id IS NULL THEN
    RAISE EXCEPTION 'custom_quote_approvals: quote_id % not found', NEW.quote_id USING ERRCODE = '23503';
  END IF;
  IF creator_id = NEW.approver_operator_id THEN
    RAISE EXCEPTION 'custom_quote_approvals: creator cannot approve own quote (two-role attestation)'
      USING ERRCODE = '23514';
  END IF;
  NEW.content_hash := encode(
    digest(
      NEW.quote_id::text || '|' ||
      NEW.approver_operator_id::text || '|' ||
      NEW.decision || '|' ||
      NEW.reason,
      'sha256'
    ),
    'hex'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER custom_quote_approvals_before_insert_trg
  BEFORE INSERT ON custom_quote_approvals
  FOR EACH ROW EXECUTE FUNCTION custom_quote_approvals_before_insert();

-- BEFORE UPDATE OR DELETE: immutability guard.
CREATE OR REPLACE FUNCTION custom_quote_approvals_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'custom_quote_approvals rows are immutable' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER custom_quote_approvals_immutable_trg
  BEFORE UPDATE OR DELETE ON custom_quote_approvals
  FOR EACH ROW EXECUTE FUNCTION custom_quote_approvals_immutable();
