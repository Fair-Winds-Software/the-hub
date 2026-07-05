// Authorized by HUB-1396 (E-CMP-WAVE4 S3) — FE row + payload types mirroring the
// HUB-1385 CRUD API response shapes. Kept as a thin FE-only type module rather than
// importing backend types because @maverick-launch/hub-sdk is not wired in yet
// (per user's directive to defer BE↔FE package wiring until later).

export type DeviceStatus = 'active' | 'decommissioned';

export type DeviceComplianceType = 'mdm_enrollment' | 'disk_encryption' | 'screen_lock';

export type DeviceComplianceStatus = 'compliant' | 'non_compliant' | 'pending_verification';

export interface DeviceRow {
  id: string;
  product_id: string;
  device_name: string;
  owner_name: string;
  owner_email: string;
  model: string | null;
  serial_number: string | null;
  enrollment_date: string | null;
  status: DeviceStatus;
  decommissioned_at: string | null;
  added_at: string;
  updated_at: string;
}

export interface DevicesListResponse {
  data: DeviceRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CreateDevicePayload {
  product_id: string;
  device_name: string;
  owner_name: string;
  owner_email: string;
  model?: string;
  serial_number?: string;
  enrollment_date?: string;
}

export interface AttestDevicePayload {
  compliance_type: DeviceComplianceType;
  status: DeviceComplianceStatus;
  attested_by: string;
}

/** Filter values shown in the status dropdown. */
export type StatusFilter = 'active' | 'decommissioned' | 'all';
