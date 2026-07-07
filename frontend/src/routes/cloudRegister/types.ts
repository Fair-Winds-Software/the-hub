// Authorized by HUB-1437 (E-CMP-WAVE4b S4) — FE types mirroring HUB-1423 API shapes.

export type CloudProvider = 'aws' | 'gcp' | 'azure' | 'other';
export type CloudEnvironment = 'production' | 'staging' | 'development';
export type CloudStatus = 'active' | 'archived';
export type CloudAttestationStatus = 'pass' | 'fail' | 'partial';

export interface CloudRow {
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
  status: CloudStatus;
  created_at: string;
  updated_at: string;
}

export interface CloudListResponse {
  data: CloudRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CreateCloudPayload {
  account_name: string;
  provider: CloudProvider;
  account_id?: string;
  environment?: CloudEnvironment;
  service_type?: string;
  owner_id?: string;
}

export interface AttestCloudPayload {
  attestation_type: string;
  status: CloudAttestationStatus;
  attested_by: string;
  findings?: string;
}

export type CloudStatusFilter = 'active' | 'archived' | 'all';
export type CloudProviderFilter = CloudProvider | 'all';
