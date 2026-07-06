// Authorized by HUB-1397 (E-CMP-WAVE4 S4) — FE types mirroring HUB-1385
// hr_onboarding_records API response shapes.

export type OnboardingStatus = 'pending' | 'in_progress' | 'completed' | 'overdue';

export interface OnboardingRow {
  id: string;
  product_id: string;
  employee_name: string;
  employee_email: string;
  role: string;
  hire_date: string;
  sla_deadline: string;
  status: OnboardingStatus;
  attested_by: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OnboardingListResponse {
  data: OnboardingRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CreateOnboardingPayload {
  product_id: string;
  employee_name: string;
  employee_email: string;
  role: string;
  hire_date: string;
}

export type OnboardingStatusFilter = 'pending' | 'completed' | 'all';
