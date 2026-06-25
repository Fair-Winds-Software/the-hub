// Authorized by HUB-1579 — logout flow per R1 D-HUB-SCOPE-028 + D-HUB-SCOPE-050.
// Sequence (per AC#1: local clear + cookie clear + redirect complete within ~200ms,
// independent of BE response):
//   1. Capture refresh token from session store BEFORE clearing.
//   2. Clear session store + zero the refresh cookie + invoke navigate('/console/login').
//   3. Fire-and-forget POST /api/v1/admin/auth/logout in the background.
//      If the BE call rejects, enqueue the refresh token in sessionStorage for the next
//      bootstrap drain (see lib/pendingRevokes).
// The BE call is intentionally not awaited; navigation happens immediately.

import { apiClient } from './api';
import { enqueueRevoke } from './pendingRevokes';
import { useSessionStore } from '../stores/sessionStore';

const LOGOUT_PATH = '/api/v1/admin/auth/logout';
const REFRESH_COOKIE_NAME = 'hub_refresh_token';

export interface PerformLogoutDeps {
  /** React Router navigate function. Required so this module stays router-agnostic. */
  navigate: (path: string) => void;
}

/**
 * Clear the refresh-token cookie. The cookie is httpOnly when set by the BE, so this
 * client-side write CANNOT delete it. The BE clears its cookie when /logout is called.
 * However we still set Max-Age=0 on any same-name client cookie as a defensive
 * belt-and-suspenders measure (e.g., if a future build accidentally writes a non-httpOnly
 * cookie of the same name, this ensures it is wiped on logout).
 */
function clearRefreshCookie(): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${REFRESH_COOKIE_NAME}=; Max-Age=0; Path=/; SameSite=Lax`;
}

/**
 * Fire the BE logout call; enqueue on failure. Returns a promise so tests can await,
 * but production callers should NOT await it (per AC#1).
 */
export function fireAndForgetBackendLogout(refreshToken: string): Promise<void> {
  return apiClient
    .post<{ success: boolean }>(LOGOUT_PATH, { refreshToken })
    .then(() => undefined)
    .catch(() => {
      // BE unreachable / 5xx / timeout — preserve the revoke intent for the next
      // bootstrap so the token gets revoked when connectivity returns.
      enqueueRevoke(refreshToken);
    });
}

/**
 * Perform logout. Synchronously clears local session + cookie + redirects; the BE call
 * runs in the background. Returns the in-flight BE call promise so tests can await,
 * but production callers should NOT await it.
 */
export function performLogout({ navigate }: PerformLogoutDeps): Promise<void> {
  const refreshToken = useSessionStore.getState().refreshToken;
  useSessionStore.getState().clearSession();
  clearRefreshCookie();
  navigate('/console/login');

  if (refreshToken === null || refreshToken === '') {
    // No token to revoke — nothing for the BE to do.
    return Promise.resolve();
  }
  return fireAndForgetBackendLogout(refreshToken);
}
