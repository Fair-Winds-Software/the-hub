-- Authorized by HUB-1384 (E-CMP-WAVE4 S1, HUB-870) — GRC-Lite Wave 4 register schemas
-- for SOC 2 evidence outside the application boundary (endpoint management + HR
-- lifecycle). Establishes the tables the HUB-1385 CRUD API writes and the HUB-1354
-- human control evaluation engine reads via compliance signals.
--
-- Design notes:
--   * `product_id` is TEXT (per story AC), following the same product-key convention
--     as `settings.jira_project_key_by_product` — operator-supplied label, not an FK.
--     Trades referential integrity for portfolio flexibility (device/HR records
--     roll up to whichever product-key the operator assigns without needing that
--     product_id to exist yet in `products`).
--   * `device_compliance_records` is DB-level immutable: a BEFORE UPDATE OR DELETE
--     trigger raises SQLSTATE 23514 (check_violation) so callers can pattern-match
--     the same way they do CHECK violations elsewhere. A separate BEFORE INSERT
--     trigger populates `content_hash = sha256(device_id||compliance_type||status||attested_at)`
--     so the UNIQUE constraint on content_hash prevents duplicate attestations at
--     the exact same second for the same device+type+status.
--   * The 3 mutable tables carry the standard delta_data + universal_delta_tracker
--     trigger per Fairwinds convention.
--   * `compliance_controls.eval_cadence` CHECK is widened to accept 'quarterly'
--     (needed for the 90-day disk-encryption cadence).
--   * The 5 GRC control seeds are idempotent (ON CONFLICT DO NOTHING on control_id).

-- pgcrypto provides digest() for the SHA-256 content_hash trigger below.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── device_inventory (mutable) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS device_inventory (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id        TEXT        NOT NULL,
  device_name       TEXT        NOT NULL,
  owner_name        TEXT        NOT NULL,
  owner_email       TEXT        NOT NULL,
  model             TEXT,
  serial_number     TEXT,
  enrollment_date   DATE,
  added_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data        JSONB,
  CONSTRAINT device_inventory_product_serial_uq UNIQUE (product_id, serial_number)
);
CREATE INDEX IF NOT EXISTS idx_device_inventory_product ON device_inventory(product_id);
CREATE INDEX IF NOT EXISTS idx_device_inventory_owner_email ON device_inventory(owner_email);

CREATE TRIGGER track_delta_device_inventory
  BEFORE UPDATE OR DELETE ON device_inventory
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

-- ── device_compliance_records (immutable + content_hash) ──────────────────────
CREATE TABLE IF NOT EXISTS device_compliance_records (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id         UUID        NOT NULL REFERENCES device_inventory(id) ON DELETE RESTRICT,
  compliance_type   TEXT        NOT NULL
                                CHECK (compliance_type IN ('mdm_enrollment', 'disk_encryption', 'screen_lock')),
  status            TEXT        NOT NULL
                                CHECK (status IN ('compliant', 'non_compliant', 'pending_verification')),
  attested_by       TEXT        NOT NULL,
  attested_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  content_hash      TEXT        NOT NULL,
  CONSTRAINT device_compliance_records_content_hash_uq UNIQUE (content_hash)
);
CREATE INDEX IF NOT EXISTS idx_device_compliance_records_device ON device_compliance_records(device_id, compliance_type, attested_at DESC);

CREATE OR REPLACE FUNCTION device_compliance_records_content_hash()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.content_hash := encode(
    digest(
      NEW.device_id::text || '|' ||
      NEW.compliance_type || '|' ||
      NEW.status || '|' ||
      NEW.attested_at::text,
      'sha256'
    ),
    'hex'
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER device_compliance_records_set_content_hash
  BEFORE INSERT ON device_compliance_records
  FOR EACH ROW EXECUTE FUNCTION device_compliance_records_content_hash();

CREATE OR REPLACE FUNCTION device_compliance_records_immutable_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'device_compliance_records is immutable — insert a new attestation instead'
    USING ERRCODE = '23514';
END;
$$;

CREATE OR REPLACE TRIGGER device_compliance_records_immutable
  BEFORE UPDATE OR DELETE ON device_compliance_records
  FOR EACH ROW EXECUTE FUNCTION device_compliance_records_immutable_guard();

-- ── hr_onboarding_records (mutable) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_onboarding_records (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id        TEXT        NOT NULL,
  employee_name     TEXT        NOT NULL,
  employee_email    TEXT        NOT NULL,
  role              TEXT        NOT NULL,
  hire_date         DATE        NOT NULL,
  sla_deadline      DATE        NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'in_progress', 'completed', 'overdue')),
  attested_by       TEXT,
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data        JSONB,
  CONSTRAINT hr_onboarding_completed_at_matches_status
    CHECK (completed_at IS NULL OR status = 'completed')
);
CREATE INDEX IF NOT EXISTS idx_hr_onboarding_product_status ON hr_onboarding_records(product_id, status);
CREATE INDEX IF NOT EXISTS idx_hr_onboarding_sla_deadline ON hr_onboarding_records(sla_deadline);

CREATE TRIGGER track_delta_hr_onboarding_records
  BEFORE UPDATE OR DELETE ON hr_onboarding_records
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

-- ── hr_offboarding_records (mutable) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_offboarding_records (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id            TEXT        NOT NULL,
  employee_name         TEXT        NOT NULL,
  employee_email        TEXT        NOT NULL,
  role                  TEXT        NOT NULL,
  last_day              DATE        NOT NULL,
  revocation_deadline   TIMESTAMPTZ NOT NULL,
  device_returned       BOOLEAN     NOT NULL DEFAULT false,
  accounts_disabled     BOOLEAN     NOT NULL DEFAULT false,
  tokens_revoked        BOOLEAN     NOT NULL DEFAULT false,
  status                TEXT        NOT NULL DEFAULT 'pending'
                                    CHECK (status IN ('pending', 'in_progress', 'completed', 'overdue')),
  attested_by           TEXT,
  completed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delta_data            JSONB,
  CONSTRAINT hr_offboarding_completed_requires_all_revocations
    CHECK (
      completed_at IS NULL
      OR (device_returned AND accounts_disabled AND tokens_revoked)
    )
);
CREATE INDEX IF NOT EXISTS idx_hr_offboarding_product_status ON hr_offboarding_records(product_id, status);
CREATE INDEX IF NOT EXISTS idx_hr_offboarding_revocation_deadline ON hr_offboarding_records(revocation_deadline);

CREATE TRIGGER track_delta_hr_offboarding_records
  BEFORE UPDATE OR DELETE ON hr_offboarding_records
  FOR EACH ROW EXECUTE FUNCTION universal_delta_tracker();

-- ── compliance_controls.eval_cadence: widen CHECK to accept 'quarterly' ────────
-- Needed for the 90-day disk-encryption control seed below. Follows the same
-- DROP CONSTRAINT / ADD CONSTRAINT pattern as migration 048.
ALTER TABLE compliance_controls
  DROP CONSTRAINT IF EXISTS compliance_controls_eval_cadence_check;

ALTER TABLE compliance_controls
  ADD CONSTRAINT compliance_controls_eval_cadence_check
  CHECK (eval_cadence IN ('daily', 'weekly', 'monthly', 'quarterly', 'continuous'));

-- ── Seed the 5 GRC-Lite Wave 4 controls ────────────────────────────────────────
-- Idempotent on control_id UNIQUE; operator-tuned values are preserved on re-run.
INSERT INTO compliance_controls (control_id, name, description, tsc_category, control_class, eval_cadence, active)
VALUES
  ('device-mdm-compliance',
   'Device MDM Compliance',
   'Employee device is enrolled in MDM. Attested by IT lead on a rolling 30-day cadence.',
   'CC6.7', 'human', 'monthly', true),
  ('device-disk-encryption',
   'Device Disk Encryption',
   'Employee device disk encryption (FileVault / BitLocker) is enabled. Attested on a rolling 90-day cadence.',
   'CC6.7', 'human', 'quarterly', true),
  ('device-screen-lock',
   'Device Screen Lock Policy',
   'Employee device auto-lock policy is enforced. Attested on a rolling 30-day cadence.',
   'CC6.7', 'human', 'monthly', true),
  ('hr-onboarding-sla',
   'HR Onboarding SLA',
   'New-hire provisioning checklist is completed within 7 days of hire_date.',
   'CC1.4', 'human', 'weekly', true),
  ('hr-offboarding-24h',
   'HR Offboarding 24h Revocation',
   'Departing-employee access revocation checklist (device returned, accounts disabled, tokens revoked) is completed within 24 hours of last_day.',
   'CC6.3', 'human', 'daily', true)
ON CONFLICT (control_id) DO NOTHING;
