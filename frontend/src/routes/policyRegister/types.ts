// Authorized by HUB-1438 (E-CMP-WAVE4b S5) — FE types mirroring HUB-1423 API shapes.

export type PolicyType = 'security' | 'privacy' | 'acceptable_use' | 'incident_response' | 'other';
export type PolicyStatus = 'active' | 'archived';

export interface PolicyRow {
  id: string;
  policy_name: string;
  policy_type: PolicyType;
  version: string;
  effective_date: string | null;
  review_due_date: string | null;
  review_frequency_days: number;
  owner_id: string | null;
  status: PolicyStatus;
  document_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface PolicyListResponse {
  data: PolicyRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CreatePolicyPayload {
  policy_name: string;
  policy_type: PolicyType;
  version: string;
  effective_date?: string;
  review_due_date?: string;
  owner_id?: string;
  document_url?: string;
}

export interface AcknowledgePolicyPayload {
  employee_id: string;
  employee_name: string;
  policy_version: string;
}

export type PolicyStatusFilter = 'active' | 'archived' | 'all';
export type PolicyTypeFilter = PolicyType | 'all';
