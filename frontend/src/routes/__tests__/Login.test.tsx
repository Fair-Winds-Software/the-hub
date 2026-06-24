// Authorized by HUB-1576 — Login route tests (covers ACs #1-#10 + axe-core)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { axe } from 'vitest-axe';
import Login from '../Login';
import { useSessionStore, type Operator } from '../../stores/sessionStore';

const OPERATOR: Operator = {
  id: 'op-1',
  email: 'sammy@maverick.launch',
  name: 'Sammy Hoelscher',
  role: 'super_admin',
};

const SUCCESS_RESPONSE = {
  accessToken: 'access-abc',
  refreshToken: 'refresh-xyz',
  operator: OPERATOR,
};

function mockResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function resetStore(authenticated = false): void {
  useSessionStore.setState({
    accessToken: authenticated ? 'token' : null,
    refreshToken: authenticated ? 'refresh' : null,
    operator: authenticated ? OPERATOR : null,
    isAuthenticated: authenticated,
    isHydrating: false,
  });
}

function renderLoginAt(
  initialEntries: Array<string | { pathname: string; state?: unknown }> = ['/console/login'],
) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route path="/console/login" element={<Login />} />
        <Route path="/console/dashboard" element={<div>DASHBOARD</div>} />
        <Route path="/console/audit" element={<div>AUDIT</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Login (HUB-1576)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    resetStore(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe('AC#1 + AC#10: renders standalone centered card with wordmark', () => {
    it('renders the Maverick Launch wordmark + form (no shell)', () => {
      renderLoginAt();
      expect(screen.getByText(/Maverick Launch/i)).toBeInTheDocument();
      expect(screen.getByText(/HUB Operator Console/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Sign In/i })).toBeInTheDocument();
    });
  });

  describe('AC#2: HTML5 attributes on inputs', () => {
    it('email is type=email with autocomplete=username', () => {
      renderLoginAt();
      const emailInput = screen.getByLabelText('Email') as HTMLInputElement;
      expect(emailInput.type).toBe('email');
      expect(emailInput.autocomplete).toBe('username');
    });

    it('password is type=password with autocomplete=current-password', () => {
      renderLoginAt();
      const passwordInput = screen.getByLabelText('Password') as HTMLInputElement;
      expect(passwordInput.type).toBe('password');
      expect(passwordInput.autocomplete).toBe('current-password');
    });
  });

  describe('AC#3: empty submit surfaces validation errors without API call', () => {
    it('shows inline error for missing email + password; never calls fetch', () => {
      renderLoginAt();
      fireEvent.click(screen.getByRole('button', { name: /Sign In/i }));
      expect(screen.getByText(/Enter your email/i)).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('shows missing-password error when only email is provided', () => {
      renderLoginAt();
      fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'sammy@x.io' } });
      fireEvent.click(screen.getByRole('button', { name: /Sign In/i }));
      expect(screen.getByText(/Enter your password/i)).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('AC#4 + AC#6: submit → apiClient.post + setSession + navigate to /console/dashboard', () => {
    it('on 200: stores session and navigates to dashboard', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200, SUCCESS_RESPONSE));
      renderLoginAt();
      fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'sammy@x.io' } });
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter2' } });
      fireEvent.click(screen.getByRole('button', { name: /Sign In/i }));

      await waitFor(() => {
        expect(screen.getByText('DASHBOARD')).toBeInTheDocument();
      });
      expect(useSessionStore.getState().accessToken).toBe('access-abc');
      expect(useSessionStore.getState().isAuthenticated).toBe(true);
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('/api/v1/admin/auth/login');
      expect(JSON.parse((init as RequestInit).body as string)).toEqual({
        email: 'sammy@x.io',
        password: 'hunter2',
      });
    });

    it('AC#6: on 200 with state.from, navigates to that path instead of dashboard', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200, SUCCESS_RESPONSE));
      renderLoginAt([{ pathname: '/console/login', state: { from: '/console/audit' } }]);
      fireEvent.change(screen.getByLabelText('Email'), { target: { value: 's@x' } });
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
      fireEvent.click(screen.getByRole('button', { name: /Sign In/i }));

      await waitFor(() => {
        expect(screen.getByText('AUDIT')).toBeInTheDocument();
      });
    });
  });

  describe('AC#5: submitting state shows spinner + disabled', () => {
    it('button shows "Signing in…" and is disabled while in flight', async () => {
      let resolveFetch: ((res: Response) => void) | undefined;
      fetchMock.mockReturnValueOnce(
        new Promise<Response>((resolve) => { resolveFetch = resolve; }),
      );
      renderLoginAt();
      fireEvent.change(screen.getByLabelText('Email'), { target: { value: 's@x' } });
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
      fireEvent.click(screen.getByRole('button', { name: /Sign In/i }));

      await waitFor(() => {
        expect(screen.getByText(/Signing in/i)).toBeInTheDocument();
      });
      expect(screen.getByRole('button', { name: /Signing in/i })).toBeDisabled();
      expect(screen.getByLabelText('Email')).toBeDisabled();
      expect(screen.getByLabelText('Password')).toBeDisabled();

      resolveFetch!(mockResponse(200, SUCCESS_RESPONSE));
    });
  });

  describe('AC#7: 401 → server error inline + password cleared + email preserved + re-enable', () => {
    it('renders error code + message; clears password; preserves email; re-enables button', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(401, { error: 'invalid_credentials' }));
      renderLoginAt();
      fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'sammy@x.io' } });
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong-password' } });
      fireEvent.click(screen.getByRole('button', { name: /Sign In/i }));

      await waitFor(() => {
        expect(screen.getByText(/AUTH_INVALID_CREDENTIALS/)).toBeInTheDocument();
      });
      expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('sammy@x.io');
      expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
      expect(screen.getByRole('button', { name: /Sign In/i })).not.toBeDisabled();
    });
  });

  describe('AC#8: network error → generic message + re-enable', () => {
    it('on fetch rejection (network), surfaces "Unable to reach the server"', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      renderLoginAt();
      fireEvent.change(screen.getByLabelText('Email'), { target: { value: 's@x' } });
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
      fireEvent.click(screen.getByRole('button', { name: /Sign In/i }));

      await waitFor(() => {
        expect(screen.getByText(/Unable to reach the server/i)).toBeInTheDocument();
      });
      expect(screen.getByRole('button', { name: /Sign In/i })).not.toBeDisabled();
    });
  });

  describe('AC#9: already-authenticated → immediate redirect to dashboard', () => {
    it('mount-time redirect when session is populated', async () => {
      resetStore(true);
      renderLoginAt();
      await waitFor(() => {
        expect(screen.getByText('DASHBOARD')).toBeInTheDocument();
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('AC#9 + AC#6 cascade: state.from honored on already-authenticated redirect', async () => {
      resetStore(true);
      renderLoginAt([{ pathname: '/console/login', state: { from: '/console/audit' } }]);
      await waitFor(() => {
        expect(screen.getByText('AUDIT')).toBeInTheDocument();
      });
    });
  });

  describe('A11y: axe-core 0 violations', () => {
    it('initial render has zero axe violations', async () => {
      const { container } = renderLoginAt();
      const results = await axe(container);
      expect(results.violations).toHaveLength(0);
    });

    it('post-validation-error state has zero axe violations', async () => {
      const { container } = renderLoginAt();
      fireEvent.click(screen.getByRole('button', { name: /Sign In/i }));
      const results = await axe(container);
      expect(results.violations).toHaveLength(0);
    });
  });
});
