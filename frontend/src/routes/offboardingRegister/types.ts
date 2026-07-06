// Authorized by HUB-1398 (E-CMP-WAVE4 S5) — FE types mirroring HUB-1385
// hr_offboarding_records API response shapes.

export type OffboardingStatus = 'pending' | 'in_progress' | 'completed' | 'overdue';

export interface OffboardingRow {
  id: string;
  product_id: string;
  employee_name: string;
  employee_email: string;
  role: string;
  last_day: string;
  revocation_deadline: string;
  device_returned: boolean;
  accounts_disabled: boolean;
  tokens_revoked: boolean;
  status: OffboardingStatus;
  attested_by: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OffboardingListResponse {
  data: OffboardingRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CreateOffboardingPayload {
  product_id: string;
  employee_name: string;
  employee_email: string;
  role: string;
  last_day: string;
}

/** PUT /:id/checklist accepts any subset of the three checklist booleans. */
export interface OffboardingChecklistPayload {
  device_returned?: boolean;
  accounts_disabled?: boolean;
  tokens_revoked?: boolean;
}

export type OffboardingStatusFilter = 'pending' | 'completed' | 'all';
