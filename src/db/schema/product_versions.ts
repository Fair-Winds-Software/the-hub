// Authorized by HUB-321 — product_versions TypeScript schema; SDK version registry row type
export interface ProductVersionRow {
  id: string;
  product_id: string;
  version: string;
  status: 'supported' | 'deprecated' | 'sunset';
  deprecated_at: Date | null;
  sunset_at: Date | null;
  release_notes: string | null;
  created_by: string;
  delta_data: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}
