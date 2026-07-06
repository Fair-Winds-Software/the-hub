// Authorized by HUB-1422 (E-CMP-WAVE4b S1, HUB-871) — TypeScript SSoT for the
// GRC-Lite Wave 4b register row shapes. Mirrors migration 069's table columns so
// the CRUD API (HUB-1423) + UIs (HUB-1436/1437/1438) can share a single type
// contract without redefining shapes at every layer.

export type VendorType = 'saas' | 'infrastructure' | 'professional_services' | 'other';
export type VendorDataAccessLevel = 'none' | 'limited' | 'full';
export type VendorRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type CloudProvider = 'aws' | 'gcp' | 'azure' | 'other';
export type CloudEnvironment = 'production' | 'staging' | 'development';
export type CloudAttestationStatus = 'pass' | 'fail' | 'partial';
export type PolicyType = 'security' | 'privacy' | 'acceptable_use' | 'incident_response' | 'other';
export type GrcReviewStatus = 'active' | 'archived';

export interface VendorRegister {
  id: string;
  vendor_name: string;
  vendor_type: VendorType;
  website: string | null;
  contract_start_date: string | null;
  contract_end_date: string | null;
  data_access_level: VendorDataAccessLevel | null;
  risk_level: VendorRiskLevel | null;
  last_reviewed_at: string | null;
  next_review_due: string | null;
  review_frequency_days: number;
  status: GrcReviewStatus;
  created_at: string;
  updated_at: string;
}

export interface VendorRiskAssessment {
  id: string;
  vendor_id: string;
  risk_score: number;
  findings: string | null;
  assessed_by: string;
  /** SHA-256 of `vendor_id|risk_score|assessed_by|findings`; populated by DB trigger. */
  content_hash: string;
  created_at: string;
}

export interface CloudInfrastructure {
  id: string;
  account_name: string;
  provider: CloudProvider;
  account_id: string | null;
  environment: CloudEnvironment | null;
  service_type: string | null;
  owner_id: string | null;
  security_score: number | null;
  last_audited_at: string | null;
  next_audit_due: string | null;
  audit_frequency_days: number;
  status: GrcReviewStatus;
  created_at: string;
  updated_at: string;
}

export interface CloudSecurityAttestation {
  id: string;
  account_id: string;
  attestation_type: string;
  status: CloudAttestationStatus;
  attested_by: string;
  findings: string | null;
  content_hash: string;
  created_at: string;
}

export interface PolicyRegister {
  id: string;
  policy_name: string;
  policy_type: PolicyType;
  version: string;
  effective_date: string | null;
  review_due_date: string | null;
  review_frequency_days: number;
  owner_id: string | null;
  status: GrcReviewStatus;
  document_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface PolicyAcknowledgment {
  id: string;
  policy_id: string;
  employee_id: string;
  employee_name: string;
  acknowledged_at: string;
  policy_version: string;
  content_hash: string;
  created_at: string;
}
