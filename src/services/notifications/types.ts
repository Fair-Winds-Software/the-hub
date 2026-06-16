// Authorized by HUB-732 — shared types for notification delivery worker and channel handlers

export interface AlertJobData {
  alertId: string;
  tenantId: string;
  productId: string;
  alertType: string;
  severity: string;
  fireCount: number;
}

export interface NotificationChannel {
  id: string;
  tenant_id: string;
  product_id: string;
  channel_type: 'email' | 'webhook' | 'in_app';
  config: Record<string, unknown>;
  hmac_secret: string | null;
  enabled: boolean;
  created_at: Date;
}
