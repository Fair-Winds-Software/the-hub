-- Authorized by HUB-1422 (E-CMP-WAVE4b S1, HUB-871) — GRC-Lite Wave 4b register schemas
-- for SOC 2 CC9 (Vendor Management), CC6/CC7 (Cloud), CC2/CC5 (Policy Lifecycle).
-- Structural mirror of HUB-1384/migration 067 for the vendor/cloud/policy trio.
--
-- 6 tables total:
--   vendor_register              (mutable, delta_data + universal_delta_tracker)
--   vendor_risk_assessments      (immutable + content_hash SHA-256)
--   cloud_infrastructure         (mutable, delta_data + universal_delta_tracker)
--   cloud_security_attestations  (immutable + content_hash SHA-256)
--   policy_register              (mutable, delta_data + universal_delta_tracker)
--   policy_acknowledgments       (immutable + content_hash SHA-256)
--
-- Immutability trigger raises SQLSTATE 23514 (check_violation) on BEFORE UPDATE OR DELETE
-- — matches the HUB-1384 device_compliance_records pattern. Content hashes computed via
-- BEFORE INSERT trigger over the tuple documented per-table below.
--
-- Widens compliance_controls.eval_cadence CHECK to accept 'yearly' for the two 365-day
-- policy controls. Same DROP CONSTRAINT / ADD CONSTRAINT pattern used to add 'quarterly'
-- in migration 067.
--
-- All rows are portfolio-scoped (no product_id column) — vendor/cloud/policy registers
-- are shared across the Fair Winds portfolio, unlike the per-product device/HR tables.

-- pgcrypto already enabled by migration 067; CREATE EXTENSION IF NOT EXISTS is a no-op.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── vendor_register (mutable) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vendor_register (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_name               TEXT        NOT NULL,
  vendor_type               TEXT        NOT NULL
                                        CHECK (vendor_type IN ('saas', 'infrastructure', 'professional_services', 'other')),
  website                   TEXT,
  contract_start_date       DATE,
  contract_end_date         DATE,
  data_access_level         TEXT
                                        CHECK (data_access_level IS NULL OR data_access_level IN ('none', 'limited', 'full')),
  risk_level                TEXT
                                        CHECK (risk_level IS NULL OR risk_level IN ('low', 'medium', 'high', 'critical')),
  last_reviewed_at          TIMESTAMPTZ,
  next_review_due           DATE,
  review_frequency_days     INTEGER     NOT NULL DEFAULT 90,
  status                    TEXT        NOT NULL DEFAULT 'active'
                                        CHECK (status IN ('active', 'archived')),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data                JSONB,
  CONSTRAINT vendor_register_name_uq UNIQUE (vendor_name)
);
CREATE INDEX IF NOT EXISTS idx_vendor_register_status ON vendor_register(status);
CREATE INDEX IF NOT EXISTS idx_vendor_register_next_review ON vendor_register(next_review_due);

CREATE TRIGGER track_delta_vendor_register
  BEFORE UPDATE OR DELETE ON vendor_register
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

-- ── vendor_risk_assessments (immutable + content_hash) ────────────────────────
CREATE TABLE IF NOT EXISTS vendor_risk_assessments (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id         UUID        NOT NULL REFERENCES vendor_register(id) ON DELETE RESTRICT,
  risk_score        INTEGER     NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
  findings          TEXT,
  assessed_by       TEXT        NOT NULL,
  content_hash      TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT vendor_risk_assessments_content_hash_uq UNIQUE (content_hash)
);
CREATE INDEX IF NOT EXISTS idx_vendor_risk_vendor ON vendor_risk_assessments(vendor_id, created_at DESC);

CREATE OR REPLACE FUNCTION vendor_risk_assessments_content_hash()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.content_hash := encode(
    digest(
      NEW.vendor_id::text || '|' ||
      NEW.risk_score::text || '|' ||
      NEW.assessed_by || '|' ||
      COALESCE(NEW.findings, ''),
      'sha256'
    ),
    'hex'
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER vendor_risk_assessments_set_content_hash
  BEFORE INSERT ON vendor_risk_assessments
  FOR EACH ROW EXECUTE FUNCTION vendor_risk_assessments_content_hash();

CREATE OR REPLACE FUNCTION vendor_risk_assessments_immutable_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'vendor_risk_assessments is immutable — insert a new assessment instead'
    USING ERRCODE = '23514';
END;
$$;

CREATE OR REPLACE TRIGGER vendor_risk_assessments_immutable
  BEFORE UPDATE OR DELETE ON vendor_risk_assessments
  FOR EACH ROW EXECUTE FUNCTION vendor_risk_assessments_immutable_guard();

-- ── cloud_infrastructure (mutable) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cloud_infrastructure (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_name              TEXT        NOT NULL,
  provider                  TEXT        NOT NULL
                                        CHECK (provider IN ('aws', 'gcp', 'azure', 'other')),
  account_id                TEXT,
  environment               TEXT
                                        CHECK (environment IS NULL OR environment IN ('production', 'staging', 'development')),
  service_type              TEXT,
  owner_id                  TEXT,
  security_score            INTEGER     CHECK (security_score IS NULL OR security_score BETWEEN 0 AND 100),
  last_audited_at           TIMESTAMPTZ,
  next_audit_due            DATE,
  audit_frequency_days      INTEGER     NOT NULL DEFAULT 90,
  status                    TEXT        NOT NULL DEFAULT 'active'
                                        CHECK (status IN ('active', 'archived')),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data                JSONB,
  CONSTRAINT cloud_infrastructure_provider_account_uq UNIQUE (provider, account_id)
);
CREATE INDEX IF NOT EXISTS idx_cloud_infra_status ON cloud_infrastructure(status);
CREATE INDEX IF NOT EXISTS idx_cloud_infra_next_audit ON cloud_infrastructure(next_audit_due);

CREATE TRIGGER track_delta_cloud_infrastructure
  BEFORE UPDATE OR DELETE ON cloud_infrastructure
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

-- ── cloud_security_attestations (immutable + content_hash) ────────────────────
CREATE TABLE IF NOT EXISTS cloud_security_attestations (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID        NOT NULL REFERENCES cloud_infrastructure(id) ON DELETE RESTRICT,
  attestation_type  TEXT        NOT NULL,
  status            TEXT        NOT NULL
                                CHECK (status IN ('pass', 'fail', 'partial')),
  attested_by       TEXT        NOT NULL,
  findings          TEXT,
  content_hash      TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT cloud_security_attestations_content_hash_uq UNIQUE (content_hash)
);
CREATE INDEX IF NOT EXISTS idx_cloud_attestations_account ON cloud_security_attestations(account_id, created_at DESC);

CREATE OR REPLACE FUNCTION cloud_security_attestations_content_hash()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.content_hash := encode(
    digest(
      NEW.account_id::text || '|' ||
      NEW.attestation_type || '|' ||
      NEW.status || '|' ||
      NEW.attested_by,
      'sha256'
    ),
    'hex'
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER cloud_security_attestations_set_content_hash
  BEFORE INSERT ON cloud_security_attestations
  FOR EACH ROW EXECUTE FUNCTION cloud_security_attestations_content_hash();

CREATE OR REPLACE FUNCTION cloud_security_attestations_immutable_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'cloud_security_attestations is immutable — insert a new attestation instead'
    USING ERRCODE = '23514';
END;
$$;

CREATE OR REPLACE TRIGGER cloud_security_attestations_immutable
  BEFORE UPDATE OR DELETE ON cloud_security_attestations
  FOR EACH ROW EXECUTE FUNCTION cloud_security_attestations_immutable_guard();

-- ── policy_register (mutable) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS policy_register (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_name               TEXT        NOT NULL,
  policy_type               TEXT        NOT NULL
                                        CHECK (policy_type IN ('security', 'privacy', 'acceptable_use', 'incident_response', 'other')),
  version                   TEXT        NOT NULL,
  effective_date            DATE,
  review_due_date           DATE,
  review_frequency_days     INTEGER     NOT NULL DEFAULT 365,
  owner_id                  TEXT,
  status                    TEXT        NOT NULL DEFAULT 'active'
                                        CHECK (status IN ('active', 'archived')),
  document_url              TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data                JSONB,
  CONSTRAINT policy_register_name_version_uq UNIQUE (policy_name, version)
);
CREATE INDEX IF NOT EXISTS idx_policy_register_status ON policy_register(status);
CREATE INDEX IF NOT EXISTS idx_policy_register_review_due ON policy_register(review_due_date);

CREATE TRIGGER track_delta_policy_register
  BEFORE UPDATE OR DELETE ON policy_register
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

-- ── policy_acknowledgments (immutable + content_hash) ─────────────────────────
CREATE TABLE IF NOT EXISTS policy_acknowledgments (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id         UUID        NOT NULL REFERENCES policy_register(id) ON DELETE RESTRICT,
  employee_id       TEXT        NOT NULL,
  employee_name     TEXT        NOT NULL,
  acknowledged_at   TIMESTAMPTZ NOT NULL,
  policy_version    TEXT        NOT NULL,
  content_hash      TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT policy_acknowledgments_content_hash_uq UNIQUE (content_hash)
);
CREATE INDEX IF NOT EXISTS idx_policy_ack_policy ON policy_acknowledgments(policy_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_policy_ack_employee ON policy_acknowledgments(employee_id);

CREATE OR REPLACE FUNCTION policy_acknowledgments_content_hash()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.content_hash := encode(
    digest(
      NEW.policy_id::text || '|' ||
      NEW.employee_id || '|' ||
      NEW.policy_version || '|' ||
      NEW.acknowledged_at::text,
      'sha256'
    ),
    'hex'
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER policy_acknowledgments_set_content_hash
  BEFORE INSERT ON policy_acknowledgments
  FOR EACH ROW EXECUTE FUNCTION policy_acknowledgments_content_hash();

CREATE OR REPLACE FUNCTION policy_acknowledgments_immutable_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'policy_acknowledgments is immutable — insert a new acknowledgment instead'
    USING ERRCODE = '23514';
END;
$$;

CREATE OR REPLACE TRIGGER policy_acknowledgments_immutable
  BEFORE UPDATE OR DELETE ON policy_acknowledgments
  FOR EACH ROW EXECUTE FUNCTION policy_acknowledgments_immutable_guard();

-- ── compliance_controls.eval_cadence: widen CHECK to accept 'yearly' ──────────
-- Needed for the 365-day policy-acknowledgment + policy-review cadences.
-- Same DROP / ADD pattern used to add 'quarterly' in migration 067.
ALTER TABLE compliance_controls
  DROP CONSTRAINT IF EXISTS compliance_controls_eval_cadence_check;

ALTER TABLE compliance_controls
  ADD CONSTRAINT compliance_controls_eval_cadence_check
  CHECK (eval_cadence IN ('daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'continuous'));

-- ── Seed the 5 GRC-Lite Wave 4b controls ──────────────────────────────────────
-- Idempotent on control_id UNIQUE; operator-tuned rows are preserved.
INSERT INTO compliance_controls (control_id, name, description, tsc_category, control_class, eval_cadence, active)
VALUES
  ('vendor-risk-review',
   'Vendor Risk Review',
   'Third-party vendor risk is assessed on a rolling 90-day cadence.',
   'CC9.1', 'human', 'quarterly', true),
  ('cloud-access-review',
   'Cloud Account Access Review',
   'Cloud infrastructure account access is reviewed on a rolling 30-day cadence.',
   'CC6.6', 'human', 'monthly', true),
  ('cloud-security-audit',
   'Cloud Security Audit',
   'Cloud infrastructure security posture is audited on a rolling 90-day cadence.',
   'CC7.2', 'human', 'quarterly', true),
  ('policy-acknowledgment',
   'Policy Acknowledgment',
   'Employees acknowledge published policies on a rolling 365-day cadence.',
   'CC2.2', 'human', 'yearly', true),
  ('policy-review',
   'Policy Review',
   'Published policies are reviewed for currency on a rolling 365-day cadence.',
   'CC5.3', 'human', 'yearly', true)
ON CONFLICT (control_id) DO NOTHING;
