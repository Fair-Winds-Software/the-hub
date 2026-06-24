// Authorized by HUB-1573 — error class hierarchy for apiClient (S4 of HUB-1555)
// Subclasses are distinguished by `instanceof` checks in consumers; do not check by `name` string.

export class ApiError extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Thrown when the access token is invalid AND the refresh attempt failed.
 * The session store has already been cleared by the time this is thrown;
 * the router-level redirect to `/console/login` is the consumer's responsibility.
 */
export class SessionExpiredError extends ApiError {
  constructor(status: number, message = 'Session expired') {
    super(status, message);
    this.name = 'SessionExpiredError';
  }
}

/**
 * Thrown on 403. The operator is authenticated but lacks permission for the action.
 * NEVER triggers a refresh — this is RBAC, not auth expiry.
 */
export class PermissionDeniedError extends ApiError {
  constructor(status: number, message = 'Permission denied') {
    super(status, message);
    this.name = 'PermissionDeniedError';
  }
}

/**
 * Thrown on 5xx responses. Network errors / 5xx server errors propagate to the caller
 * for the consumer's own retry / toast / error-boundary handling.
 */
export class ServerError extends ApiError {
  constructor(status: number, message = 'Server error') {
    super(status, message);
    this.name = 'ServerError';
  }
}
