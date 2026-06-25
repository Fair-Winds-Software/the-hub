// Authorized by HUB-1579 — logout flow contract tests.
// Verifies all 5 R1 ACs (D-HUB-SCOPE-028) at the lib/logout boundary:
//   AC#1 local clear + cookie clear + redirect complete within ~200ms
//   AC#2 BE revoke attempted on logout
//   AC#3 BE failure → enqueue in pendingRevokes
//   AC#4 (covered in App-level test) drain runs on bootstrap
//   AC#5 (covered by sessionStorage semantics + browser; not unit-testable here)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { performLogout, fireAndForgetBackendLogout } from '../logout';
import { useSessionStore, type Operator } from '../../stores/sessionStore';
import { getPendingRevokes } from '../pendingRevokes';

const OP: Operator = {
  id: 'op-1',
  email: 's@maverick.example',
  name: 'Sammy H.',
  role: 'super_admin',
};

function seedSession(refreshToken: string | null = 'rt-active'): void {
  useSessionStore.setState({
    accessToken: 'at-1',
    refreshToken,
    operator: OP,
    isAuthenticated: refreshToken !== null,
    isHydrating: false,
  });
}

describe('performLogout (HUB-1579)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.sessionStorage.clear();
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    document.cookie = 'hub_refresh_token=stale; Path=/';
  });

  afterEach(() => {
    useSessionStore.setState({
      accessToken: null,
      refreshToken: null,
      operator: null,
      isAuthenticated: false,
      isHydrating: false,
    });
    window.sessionStorage.clear();
  });

  it('AC#1: clears the session store synchronously', () => {
    seedSession();
    const navigate = vi.fn();
    performLogout({ navigate });
    const state = useSessionStore.getState();
    expect(state.accessToken).toBeNull();
    expect(state.refreshToken).toBeNull();
    expect(state.operator).toBeNull();
    expect(state.isAuthenticated).toBe(false);
  });

  it('AC#1: navigates to /console/login synchronously', () => {
    seedSession();
    const navigate = vi.fn();
    performLogout({ navigate });
    expect(navigate).toHaveBeenCalledWith('/console/login');
  });

  it('AC#1: zeros the refresh cookie on the client', () => {
    seedSession();
    const navigate = vi.fn();
    performLogout({ navigate });
    // Cookie write with Max-Age=0 removes it from document.cookie.
    expect(document.cookie).not.toContain('hub_refresh_token=stale');
  });

  it('AC#2: fires POST /api/v1/admin/auth/logout with the refresh token in body', async () => {
    seedSession('rt-token-xyz');
    const navigate = vi.fn();
    await performLogout({ navigate });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe('/api/v1/admin/auth/logout');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ refreshToken: 'rt-token-xyz' });
  });

  it('AC#2: skips the BE call when no refresh token is present', async () => {
    seedSession(null);
    const navigate = vi.fn();
    await performLogout({ navigate });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('AC#3: enqueues refresh token in pendingRevokes when BE returns 503', async () => {
    seedSession('rt-enqueue-me');
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'down' }), { status: 503 }),
    );
    const navigate = vi.fn();
    await performLogout({ navigate });
    const queue = getPendingRevokes();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.refreshToken).toBe('rt-enqueue-me');
  });

  it('AC#3: enqueues refresh token when fetch itself rejects (network error)', async () => {
    seedSession('rt-network-fail');
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const navigate = vi.fn();
    await performLogout({ navigate });
    const queue = getPendingRevokes();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.refreshToken).toBe('rt-network-fail');
  });

  it('AC#3: does NOT enqueue on 200 success', async () => {
    seedSession('rt-success');
    const navigate = vi.fn();
    await performLogout({ navigate });
    expect(getPendingRevokes()).toEqual([]);
  });

  it('AC#1 ordering: session is cleared BEFORE navigate is called (no race)', () => {
    seedSession();
    const navigate = vi.fn(() => {
      // navigate runs after clearSession — assert state is already cleared.
      expect(useSessionStore.getState().accessToken).toBeNull();
    });
    performLogout({ navigate });
    expect(navigate).toHaveBeenCalled();
  });

  it('AC#1 ordering: BE call is fire-and-forget — clearSession + navigate do not await it', () => {
    seedSession('rt-1');
    let resolveBE: (v: unknown) => void = () => {};
    fetchMock.mockReturnValueOnce(
      new Promise((res) => {
        resolveBE = res;
      }),
    );
    const navigate = vi.fn();
    const promise = performLogout({ navigate });
    // Local clear + navigate happened synchronously even though BE call is still pending.
    expect(navigate).toHaveBeenCalled();
    expect(useSessionStore.getState().refreshToken).toBeNull();
    // Resolve the BE call so the returned promise can settle and the test can drain.
    resolveBE(new Response('{}', { status: 200 }));
    return promise;
  });
});

describe('fireAndForgetBackendLogout (HUB-1579)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.sessionStorage.clear();
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    window.sessionStorage.clear();
  });

  it('resolves on 200 without enqueueing', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
    await fireAndForgetBackendLogout('rt-direct');
    expect(getPendingRevokes()).toEqual([]);
  });

  it('enqueues on 500', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await fireAndForgetBackendLogout('rt-500');
    expect(getPendingRevokes().map((e) => e.refreshToken)).toEqual(['rt-500']);
  });
});
