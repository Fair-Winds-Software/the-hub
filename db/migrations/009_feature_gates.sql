-- Authorized by HUB-286 — feature_gates table; product-level gate definitions and kill switch state
CREATE TABLE IF NOT EXISTS feature_gates (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id         UUID         NOT NULL REFERENCES product_registrations(id) ON DELETE RESTRICT,
  gate_key           VARCHAR(255) NOT NULL,
  description        TEXT,
  default_enabled    BOOLEAN      NOT NULL DEFAULT FALSE,
  kill_switch_active BOOLEAN      NOT NULL DEFAULT FALSE,
  kill_switch_reason TEXT,
  kill_switch_set_at TIMESTAMPTZ,
  kill_switch_set_by TEXT,
  delta_data         JSONB,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS feature_gates_product_key_idx ON feature_gates (product_id, gate_key);

CREATE TRIGGER feature_gates_updated_at
  BEFORE UPDATE ON feature_gates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER feature_gates_delta_tracker
  BEFORE UPDATE OR DELETE ON feature_gates
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();
