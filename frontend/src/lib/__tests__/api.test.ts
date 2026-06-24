// Authorized by HUB-1573 — apiClient unit tests for all 7 ACs (mocked fetch + sessionStore reset)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '../api';
import { PermissionDeniedError, ServerError, SessionExpiredError } from '../errors';
import { useSessionStore, type Operator } from '../../stores/sessionStore';

const OPERATOR: Operator = {
  id: 'op-1',
  email: 'sammy@maverick.example',
  name: 'Sammy',
  role: 'super_admin',
};

const REFRESHED_PAYLOAD = {
  accessToken: 'new-access-token',
  refreshToken: 'new-refresh-token',
  operator: OPERATOR,
};

function mockResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function resetStore(authenticated = true): void {
  if (authenticated) {
    useSessionStore.setState({
      accessToken: 'stale-access-token',
      refreshToken: 'stale-refresh-token',
      operator: OPERATOR,
      isAuthenticated: true,
      isHydrating: false,
    });
  } else {
    useSessionStore.setState({
      accessToken: null,
      refreshToken: null,
      operator: null,
      isAuthenticated: false,
      isHydrating: false,
    });
  }
}

describe('apiClient (HUB-1573)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    resetStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe('AC#2: 401 on admin → refresh → retry succeeds', () => {
    it('returns the retried response transparently to the caller', async () => {
      fetchMock
        .mockResolvedValueOnce(mockResponse(401, { error: 'expired' }))
        .mockResolvedValueOnce(mockResponse(200, REFRESHED_PAYLOAD))
        .mockResolvedValueOnce(mockResponse(200, { ok: true, data: 'after-refresh' }));

      const result = await apiClient.get<{ ok: boolean; data: string }>(
        '/api/v1/admin/portfolio',
      );
      expect(result).toEqual({ ok: true, data: 'after-refresh' });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      // Session store should have the new token after refresh.
      expect(useSessionStore.getState().accessToken).toBe('new-access-token');
    });
  });

  describe('AC#3: parallel 401s share single in-flight refresh promise', () => {
    it('issues ONE refresh fetch even when 3 admin requests 401 simultaneously', async () => {
      let refreshResolve: ((value: Response) => void) | undefined;
      const refreshPromise = new Promise<Response>((resolve) => {
        refreshResolve = resolve;
      });

      // First 3 fetches return 401; 4th is the (single) refresh; 5th-7th are the retries.
      // Each retry needs a fresh Response (bodies can only be read once).
      fetchMock
        .mockResolvedValueOnce(mockResponse(401, {}))
        .mockResolvedValueOnce(mockResponse(401, {}))
        .mockResolvedValueOnce(mockResponse(401, {}))
        .mockReturnValueOnce(refreshPromise)
        .mockResolvedValueOnce(mockResponse(200, { data: 'retried-a' }))
        .mockResolvedValueOnce(mockResponse(200, { data: 'retried-b' }))
        .mockResolvedValueOnce(mockResponse(200, { data: 'retried-c' }));

      const requests = Promise.all([
        apiClient.get('/api/v1/admin/a'),
        apiClient.get('/api/v1/admin/b'),
        apiClient.get('/api/v1/admin/c'),
      ]);

      // Wait for all 3 initial 401s to register, then resolve the refresh.
      await Promise.resolve();
      await Promise.resolve();
      refreshResolve!(mockResponse(200, REFRESHED_PAYLOAD));
      await requests;

      // 3 initial + 1 refresh + 3 retries = 7 fetches; only 1 refresh.
      expect(fetchMock).toHaveBeenCalledTimes(7);
      const refreshCalls = fetchMock.mock.calls.filter(
        (call) => call[0] === '/api/v1/admin/auth/refresh',
      );
      expect(refreshCalls).toHaveLength(1);
    });
  });

  describe('AC#4: refresh returns 401 → clearSession + SessionExpiredError + all queued reject', () => {
    it('clears the session store and rejects all queued requests', async () => {
      fetchMock
        .mockResolvedValueOnce(mockResponse(401, {}))
        .mockResolvedValueOnce(mockResponse(401, {}))
        .mockResolvedValueOnce(mockResponse(401, { error: 'refresh_failed' }));

      const results = await Promise.allSettled([
        apiClient.get('/api/v1/admin/a'),
        apiClient.get('/api/v1/admin/b'),
      ]);

      expect(results[0].status).toBe('rejected');
      expect(results[1].status).toBe('rejected');
      const reason0 = (results[0] as PromiseRejectedResult).reason;
      expect(reason0).toBeInstanceOf(SessionExpiredError);

      // Session store cleared by internalRefreshAndUpdateStore.
      const state = useSessionStore.getState();
      expect(state.isAuthenticated).toBe(false);
      expect(state.accessToken).toBeNull();
    });
  });

  describe('AC#5: 401 on non-admin endpoints does NOT trigger refresh', () => {
    it('propagates SessionExpiredError without calling refresh', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(401, {}));

      await expect(apiClient.get('/api/v1/public/health')).rejects.toBeInstanceOf(
        SessionExpiredError,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const refreshCalls = fetchMock.mock.calls.filter(
        (call) => call[0] === '/api/v1/admin/auth/refresh',
      );
      expect(refreshCalls).toHaveLength(0);
    });
  });

  describe('AC#6: 403 → PermissionDeniedError (no refresh)', () => {
    it('throws PermissionDeniedError without triggering refresh', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(403, { error: 'forbidden' }));

      await expect(apiClient.get('/api/v1/admin/portfolio')).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('5xx errors → ServerError', () => {
    it('throws ServerError on 503', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(503, {}));
      await expect(apiClient.get('/api/v1/admin/portfolio')).rejects.toBeInstanceOf(
        ServerError,
      );
    });
  });

  describe('AC#7 (equivalent to AC#2 mechanism): 16-min-old token transparent refresh', () => {
    it('caller receives the post-refresh data without seeing a sign-out', async () => {
      fetchMock
        .mockResolvedValueOnce(mockResponse(401, { error: 'token_expired' }))
        .mockResolvedValueOnce(mockResponse(200, REFRESHED_PAYLOAD))
        .mockResolvedValueOnce(mockResponse(200, { mrr_cents: 12345 }));

      const result = await apiClient.get<{ mrr_cents: number }>(
        '/api/v1/admin/advisor/portfolio/summary',
      );
      expect(result.mrr_cents).toBe(12345);
      // Session never cleared during the silent refresh.
      expect(useSessionStore.getState().isAuthenticated).toBe(true);
    });
  });

  describe('apiClient.refresh() standalone (HUB-1572 bootstrap consumer)', () => {
    it('returns SessionPayload WITHOUT mutating the session store', async () => {
      resetStore(false); // start unauthenticated to detect any unwanted mutation
      fetchMock.mockResolvedValueOnce(mockResponse(200, REFRESHED_PAYLOAD));

      const payload = await apiClient.refresh();
      expect(payload).toEqual(REFRESHED_PAYLOAD);
      // No store mutation — the caller (sessionStore.hydrateFromRefresh) handles state.
      expect(useSessionStore.getState().accessToken).toBeNull();
      expect(useSessionStore.getState().isAuthenticated).toBe(false);
    });

    it('throws SessionExpiredError on refresh 401 WITHOUT mutating the store', async () => {
      resetStore(false);
      fetchMock.mockResolvedValueOnce(mockResponse(401, {}));

      await expect(apiClient.refresh()).rejects.toBeInstanceOf(SessionExpiredError);
      // The standalone refresh does NOT clearSession — only the 401-retry path does.
      expect(useSessionStore.getState().isAuthenticated).toBe(false);
    });
  });

  describe('Authorization header from session store', () => {
    it('sends Bearer accessToken on admin requests', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200, { ok: true }));

      await apiClient.get('/api/v1/admin/portfolio');

      const [, init] = fetchMock.mock.calls[0];
      expect((init as RequestInit).headers).toMatchObject({
        Authorization: 'Bearer stale-access-token',
      });
    });

    it('uses credentials: include for refresh-cookie delivery', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200, { ok: true }));

      await apiClient.get('/api/v1/admin/portfolio');

      const [, init] = fetchMock.mock.calls[0];
      expect((init as RequestInit).credentials).toBe('include');
    });
  });
});
