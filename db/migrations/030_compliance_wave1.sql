-- Authorized by HUB-1019 — compliance_controls, compliance_product_registrations, product_control_bindings schemas (HUB-CMP-001, HUB-CMP-002)
-- Authorized by HUB-1020 — compliance_signal_evidence (immutable, content hash, signal_id dedup) + compliance_signal_rejections debug log

-- ── compliance_controls: SOC 2 control catalog (HUB-CMP-001) ───────────────────────────────
CREATE TABLE IF NOT EXISTS compliance_controls (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  control_id     TEXT        NOT NULL UNIQUE,
  name           TEXT        NOT NULL,
  description    TEXT,
  tsc_category   TEXT        NOT NULL,
  control_class  TEXT        NOT NULL CHECK (control_class IN ('automated', 'human')),
  signal_schema  JSONB,
  eval_cadence   TEXT        NOT NULL CHECK (eval_cadence IN ('daily', 'weekly', 'monthly', 'continuous')),
  active         BOOLEAN     NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data     JSONB
);
CREATE INDEX IF NOT EXISTS idx_compliance_controls_active ON compliance_controls(active);

CREATE TRIGGER track_delta_compliance_controls
  BEFORE UPDATE OR DELETE ON compliance_controls
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

-- ── compliance_product_registrations: per-product burn-in state machine (HUB-CMP-002) ───────
CREATE TABLE IF NOT EXISTS compliance_product_registrations (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id       UUID        NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  burn_in_state    TEXT        NOT NULL DEFAULT 'observe'
                               CHECK (burn_in_state IN ('observe', 'enforced', 'failed')),
  burn_in_started  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  burn_in_ended    TIMESTAMPTZ,
  hmac_secret_enc  TEXT        NOT NULL,
  active           BOOLEAN     NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data       JSONB,
  CONSTRAINT compliance_product_reg_product_uq UNIQUE (product_id)
);
CREATE INDEX IF NOT EXISTS idx_compliance_product_reg_product ON compliance_product_registrations(product_id);

CREATE TRIGGER track_delta_compliance_product_registrations
  BEFORE UPDATE OR DELETE ON compliance_product_registrations
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

-- ── product_control_bindings: product-to-control mapping with override support ───────────────
CREATE TABLE IF NOT EXISTS product_control_bindings (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id     UUID        NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  control_id     UUID        NOT NULL REFERENCES compliance_controls(id) ON DELETE CASCADE,
  binding_source TEXT        NOT NULL DEFAULT 'default'
                             CHECK (binding_source IN ('default', 'override')),
  active         BOOLEAN     NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data     JSONB,
  CONSTRAINT product_control_binding_uq UNIQUE (product_id, control_id)
);
CREATE INDEX IF NOT EXISTS idx_product_control_bindings_product ON product_control_bindings(product_id);

CREATE TRIGGER track_delta_product_control_bindings
  BEFORE UPDATE OR DELETE ON product_control_bindings
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

-- ── compliance_signal_evidence: immutable append-only signal log (HUB-CMP-003) ──────────────
-- No UPDATE or DELETE permitted; content_hash enforces tamper-evidence;
-- (product_id, signal_id) unique ensures each LaunchKit signal lands exactly once.
CREATE TABLE IF NOT EXISTS compliance_signal_evidence (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id      UUID        NOT NULL REFERENCES products(id),
  control_id      UUID        NOT NULL REFERENCES compliance_controls(id),
  signal_id       TEXT        NOT NULL,
  content_hash    TEXT        NOT NULL,
  payload         JSONB       NOT NULL,
  signal_type     TEXT        NOT NULL,
  observed_at     TIMESTAMPTZ NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_burn_in_gap  BOOLEAN     NOT NULL DEFAULT false,
  CONSTRAINT signal_evidence_dedup UNIQUE (product_id, signal_id)
);
CREATE INDEX IF NOT EXISTS idx_signal_evidence_product_control ON compliance_signal_evidence(product_id, control_id);
CREATE INDEX IF NOT EXISTS idx_signal_evidence_received ON compliance_signal_evidence(received_at DESC);

-- ── compliance_signal_rejections: debug log for rejected signals ──────────────────────────────
CREATE TABLE IF NOT EXISTS compliance_signal_rejections (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id       UUID,
  raw_payload      JSONB       NOT NULL,
  rejection_reason TEXT        NOT NULL,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_signal_rejections_received ON compliance_signal_rejections(received_at DESC);
