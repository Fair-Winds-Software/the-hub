// Authorized by HUB-1573 — apiClient (S4): single in-flight refresh queue + 401 retry + error classification
// HUB-1555 §9 Risk-2 mitigation: parallel admin 401s share ONE refresh promise (no thundering herd).
// Consumes session store from HUB-1572 (setSession/clearSession on refresh outcome; accessToken on each request).
// Public `apiClient.refresh()` returns SessionPayload without store side effects so HUB-1572's
// hydrateFromRefresh consumer can call it at app bootstrap.
import { useSessionStore, type SessionPayload } from '../stores/sessionStore';
import {
  ApiError,
  PermissionDeniedError,
  ServerError,
  SessionExpiredError,
} from './errors';

const ADMIN_PREFIX = '/api/v1/admin/';
const REFRESH_PATH = '/api/v1/admin/auth/refresh';
// HUB-1576: auth endpoints (login / refresh / logout) are the source of tokens, NOT consumers.
// A 401 from these endpoints means "wrong credentials" / "refresh token expired" — propagate
// as-is rather than triggering a refresh-and-retry loop.
const AUTH_PREFIX = '/api/v1/admin/auth/';

export interface RequestOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

// Module-scoped single-flight refresh promise (AC#3 mitigation for thundering-herd refresh storms).
let refreshPromise: Promise<void> | null = null;

/**
 * Raw refresh call — POSTs to the refresh endpoint with credentials (httpOnly refresh cookie),
 * returns the new session payload. Used in two contexts:
 *   1. Internal: wrapped by `internalRefreshAndUpdateStore` for the 401-retry path.
 *   2. External: exported as `apiClient.refresh` for HUB-1572 sessionStore.hydrateFromRefresh
 *      consumer at app bootstrap (no store side effects from this raw call).
 */
async function fetchRefresh(): Promise<SessionPayload> {
  // Refresh reads its token from an httpOnly cookie — no body sent. Do NOT set
  // Content-Type: application/json here or Fastify's JSON body parser will demand
  // a non-empty body and throw FastifyError 'Body cannot be empty …'.
  const res = await fetch(REFRESH_PATH, {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) {
    throw new SessionExpiredError(res.status, 'Refresh failed');
  }
  return (await res.json()) as SessionPayload;
}

/**
 * Refresh + update store. Used only by the 401-retry path inside `request()`.
 * On success: sessionStore.setSession; on failure: sessionStore.clearSession + rethrow.
 */
async function internalRefreshAndUpdateStore(): Promise<void> {
  try {
    const payload = await fetchRefresh();
    useSessionStore.getState().setSession(payload);
  } catch (err) {
    useSessionStore.getState().clearSession();
    throw err;
  }
}

function classifyError(status: number, defaultMessage: string): never {
  if (status === 401) throw new SessionExpiredError(status, 'Session expired');
  if (status === 403) throw new PermissionDeniedError(status, 'Permission denied');
  if (status >= 500) throw new ServerError(status, `Server error ${status}`);
  throw new ApiError(status, defaultMessage);
}

async function request<T>(
  method: HttpMethod,
  path: string,
  body?: unknown,
  opts?: RequestOptions,
): Promise<T> {
  const accessToken = useSessionStore.getState().accessToken;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    ...opts?.headers,
  };

  const init: RequestInit = {
    method,
    headers,
    credentials: 'include',
    signal: opts?.signal,
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  let res = await fetch(path, init);

  // Refresh-and-retry path (HUB-1573 ACs #2, #3, #4) — admin endpoints only (AC#5).
  // Auth endpoints themselves are excluded (HUB-1576): they ARE the token source, not consumers.
  if (
    res.status === 401 &&
    path.startsWith(ADMIN_PREFIX) &&
    !path.startsWith(AUTH_PREFIX)
  ) {
    if (!refreshPromise) {
      refreshPromise = internalRefreshAndUpdateStore().finally(() => {
        refreshPromise = null;
      });
    }
    // Share the single in-flight promise; throws SessionExpiredError on refresh failure (AC#4).
    await refreshPromise;

    // Refresh succeeded — retry once with the new access token.
    const newAccessToken = useSessionStore.getState().accessToken;
    const retryHeaders: Record<string, string> = {
      ...headers,
      ...(newAccessToken ? { Authorization: `Bearer ${newAccessToken}` } : {}),
    };
    res = await fetch(path, { ...init, headers: retryHeaders });
  }

  if (!res.ok) {
    classifyError(res.status, `Request failed: ${res.status}`);
  }

  // 204 No Content → return undefined as T (caller types accordingly).
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

export const apiClient = {
  get<T>(path: string, opts?: RequestOptions): Promise<T> {
    return request<T>('GET', path, undefined, opts);
  },
  post<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return request<T>('POST', path, body, opts);
  },
  put<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return request<T>('PUT', path, body, opts);
  },
  // Authorized by HUB-1605 (E-FE-3 S5) — PATCH for partial-update inline edits
  // (status / contact email) on /api/v1/admin/products/:productId.
  patch<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return request<T>('PATCH', path, body, opts);
  },
  delete<T>(path: string, opts?: RequestOptions): Promise<T> {
    return request<T>('DELETE', path, undefined, opts);
  },
  /**
   * Standalone refresh used by sessionStore.hydrateFromRefresh at app bootstrap.
   * Does NOT mutate the session store — the consumer's hydrateFromRefresh handles state.
   */
  refresh(): Promise<SessionPayload> {
    return fetchRefresh();
  },
} as const;
