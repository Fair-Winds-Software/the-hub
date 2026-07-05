// Authorized by HUB-1384 (E-CMP-WAVE4 S1, HUB-870) — TypeScript SSoT for the
// GRC-Lite Wave 4 register row shapes. Mirrors migration 067's table columns so
// the CRUD API (HUB-1385) + UIs (HUB-1396/1397/1398) can share a single type
// contract without redefining shapes at every layer.
//
// `product_id` is TEXT at the DB level (operator-supplied product key like
// 'contenthelm' or 'hub'), not a FK — see migration 067 rationale.

export type DeviceComplianceType = 'mdm_enrollment' | 'disk_encryption' | 'screen_lock';

export type DeviceComplianceStatus = 'compliant' | 'non_compliant' | 'pending_verification';

export type GrcRecordStatus = 'pending' | 'in_progress' | 'completed' | 'overdue';

export interface DeviceInventory {
  id: string;
  product_id: string;
  device_name: string;
  owner_name: string;
  owner_email: string;
  model: string | null;
  serial_number: string | null;
  enrollment_date: string | null;
  added_at: string;
  updated_at: string;
}

export interface DeviceComplianceRecord {
  id: string;
  device_id: string;
  compliance_type: DeviceComplianceType;
  status: DeviceComplianceStatus;
  attested_by: string;
  attested_at: string;
  /** SHA-256 of `device_id|compliance_type|status|attested_at`; populated by DB trigger. */
  content_hash: string;
}

export interface HrOnboardingRecord {
  id: string;
  product_id: string;
  employee_name: string;
  employee_email: string;
  role: string;
  hire_date: string;
  /** hire_date + 7 days; enforced by application layer at insert time (HUB-1385). */
  sla_deadline: string;
  status: GrcRecordStatus;
  attested_by: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface HrOffboardingRecord {
  id: string;
  product_id: string;
  employee_name: string;
  employee_email: string;
  role: string;
  last_day: string;
  /** last_day + 24h; enforced by application layer at insert time (HUB-1385). */
  revocation_deadline: string;
  device_returned: boolean;
  accounts_disabled: boolean;
  tokens_revoked: boolean;
  status: GrcRecordStatus;
  attested_by: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}
