// Authorized by HUB-921 — LeasePayload and DecryptedLease interfaces for the Lease Management SDK

export interface LeasePayload {
  tenantId: string;
  productId: string;
  features: string[];
  maxSeats: number;
  expiresAt: number;
  killSwitch: boolean;
}

export interface DecryptedLease {
  tenantId: string;
  productId: string;
  features: string[];
  maxSeats: number;
  expiresAt: number;
}
