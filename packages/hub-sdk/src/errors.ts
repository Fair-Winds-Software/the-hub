// Authorized by HUB-880 — HubAuthError; extends Error with optional statusCode for auth failures
// Authorized by HUB-921 — HubLeaseInvalidError and HubKillSwitchError for lease layer failures

export class HubAuthError extends Error {
  readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'HubAuthError';
    this.statusCode = statusCode;
  }
}

export class HubLeaseInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HubLeaseInvalidError';
  }
}

export class HubKillSwitchError extends Error {
  readonly tenantId: string;
  readonly productId: string;

  constructor(message: string, tenantId: string, productId: string) {
    super(message);
    this.name = 'HubKillSwitchError';
    this.tenantId = tenantId;
    this.productId = productId;
  }
}
