// Authorized by HUB-322 — sdk_version_reports TypeScript schema; per-tenant SDK version upsert row type
export interface SdkVersionReportRow {
  id: string;
  tenant_id: string;
  product_id: string;
  sdk_version: string;
  reported_at: Date;
  delta_data: Record<string, unknown> | null;
  created_at: Date;
}
