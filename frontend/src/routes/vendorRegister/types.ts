// Authorized by HUB-1436 (E-CMP-WAVE4b S3) — FE types mirroring HUB-1423 API shapes.

export type VendorType = 'saas' | 'infrastructure' | 'professional_services' | 'other';
export type VendorDataAccessLevel = 'none' | 'limited' | 'full';
export type VendorRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type VendorStatus = 'active' | 'archived';

export interface VendorRow {
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
  status: VendorStatus;
  created_at: string;
  updated_at: string;
}

export interface VendorListResponse {
  data: VendorRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CreateVendorPayload {
  vendor_name: string;
  vendor_type: VendorType;
  website?: string;
  contract_start_date?: string;
  contract_end_date?: string;
  data_access_level?: VendorDataAccessLevel;
  risk_level?: VendorRiskLevel;
}

export interface AssessVendorPayload {
  risk_score: number;
  assessed_by: string;
  findings?: string;
}

export type VendorStatusFilter = 'active' | 'archived' | 'all';
export type VendorRiskFilter = VendorRiskLevel | 'all';
