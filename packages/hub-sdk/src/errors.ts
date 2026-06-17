// Authorized by HUB-880 — HubAuthError; extends Error with optional statusCode for auth failures

export class HubAuthError extends Error {
  readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'HubAuthError';
    this.statusCode = statusCode;
  }
}
