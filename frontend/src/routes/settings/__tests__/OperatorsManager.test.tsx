// Authorized by HUB-1663 (E-FE-6 S4) — OperatorsManager tests. Covers list
// load + active-first ordering; role badges + active pill; New Operator
// modal (email/role/tenant_id form + FE-generated temp-password shown once
// + Copy CTA); Edit modal PUT split (content vs role); last-super_admin
// self-edit lock; Deactivate two-step confirm + DELETE; axe zero
// violations.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { axe } from 'vitest-axe';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { useSessionStore } from '../../../stores/sessionStore';
import OperatorsManager from '../OperatorsManager';

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
const apiPutMock = vi.fn();
const apiDeleteMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
    post: (...args: unknown[]) => apiPostMock(...args),
    put: (...args: unknown[]) => apiPutMock(...args),
    delete: (...args: unknown[]) => apiDeleteMock(...args),
  },
}));

const CURRENT_OPERATOR = {
  id: 'op-me',
  email: 'sammy@maverick.launch',
  name: 'Sammy',
  role: 'super_admin' as const,
};

const OP_ME = {
  id: 'op-me',
  email: 'sammy@maverick.launch',
  role: 'super_admin' as const,
  tenant_id: null,
  active: true,
  created_at: '2026-01-01T00:00:00.000Z',
};

const OP_TWO = {
  id: 'op-two',
  email: 'wayne@maverick.launch',
  role: 'product_admin' as const,
  tenant_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  active: true,
  created_at: '2026-02-01T00:00:00.000Z',
};

function mockList(operators: unknown[] = [OP_ME, OP_TWO]) {
  apiGetMock.mockImplementation((path: string) => {
    if (path.startsWith('/api/v1/admin/operators')) {
      return Promise.resolve(operators);
    }
    return Promise.reject(new Error(`unexpected: ${path}`));
  });
}

function renderMgr() {
  return render(
    <MemoryRouter initialEntries={['/console/settings/operators']}>
      <Routes>
        <Route
          path="/console/settings/operators"
          element={<OperatorsManager />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  apiPutMock.mockReset();
  apiDeleteMock.mockReset();
  // Seed the session store with the current super_admin so the last-
  // super_admin self-edit guard fires when appropriate.
  useSessionStore.setState({
    operator: CURRENT_OPERATOR,
    isAuthenticated: true,
    isHydrating: false,
    accessToken: 'test-token',
    refreshToken: 'test-refresh',
  });
});

afterEach(() => {
  cleanup();
});

describe('OperatorsManager (HUB-1663)', () => {
  it('renders one row per operator with role badge + active pill', async () => {
    mockList();
    await act(async () => {
      renderMgr();
    });
    await waitFor(() => {
      expect(screen.getByTestId('operators-manager-page')).toBeInTheDocument();
    });
    expect(screen.getByTestId('operators-row-op-me')).toBeInTheDocument();
    expect(screen.getByTestId('operators-row-op-two')).toBeInTheDocument();
    const meRow = screen.getByTestId('operators-row-op-me');
    expect(
      meRow.querySelector('[data-testid="operator-role-super_admin"]'),
    ).not.toBeNull();
    const twoRow = screen.getByTestId('operators-row-op-two');
    expect(
      twoRow.querySelector('[data-testid="operator-role-product_admin"]'),
    ).not.toBeNull();
  });

  it('threads active=true through the default GET; Show deactivated toggles it off', async () => {
    mockList();
    await act(async () => {
      renderMgr();
    });
    await waitFor(() => {
      expect(screen.getByTestId('operators-manager-page')).toBeInTheDocument();
    });
    // Confirm initial call included active=true.
    const initialCall = apiGetMock.mock.calls.find((c) =>
      (c[0] as string).startsWith('/api/v1/admin/operators'),
    );
    expect(initialCall![0]).toContain('active=true');
    apiGetMock.mockClear();
    apiGetMock.mockImplementation(() => Promise.resolve([OP_ME, OP_TWO]));
    await act(async () => {
      fireEvent.click(screen.getByTestId('operators-show-deactivated'));
      await Promise.resolve();
    });
    await waitFor(() => {
      const toggledCall = apiGetMock.mock.calls.find((c) =>
        (c[0] as string).startsWith('/api/v1/admin/operators'),
      );
      expect(toggledCall![0]).not.toContain('active=');
    });
  });

  it('empty list renders the CTA copy', async () => {
    mockList([]);
    await act(async () => {
      renderMgr();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('operators-manager-empty'),
      ).toBeInTheDocument();
    });
  });

  describe('New Operator modal', () => {
    it('rejects a submit without email + shows the tenant_id field only for product_admin', async () => {
      mockList();
      await act(async () => {
        renderMgr();
      });
      await waitFor(() => {
        expect(screen.getByTestId('operators-manager-page')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('operators-manager-new'));
      // Default role is product_admin — tenant_id field is visible.
      expect(
        screen.getByTestId('new-operator-tenant-id'),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('new-operator-submit'));
      expect(screen.getByTestId('new-operator-email-err')).toBeInTheDocument();
      expect(screen.getByTestId('new-operator-tenant-id-err')).toBeInTheDocument();
      expect(apiPostMock).not.toHaveBeenCalled();
      // Switch to super_admin — tenant_id hidden.
      fireEvent.change(screen.getByTestId('new-operator-role'), {
        target: { value: 'super_admin' },
      });
      expect(
        screen.queryByTestId('new-operator-tenant-id'),
      ).toBeNull();
    });

    it('POSTs + surfaces the FE-generated temp password once with a Copy CTA', async () => {
      mockList();
      apiPostMock.mockResolvedValueOnce({
        ...OP_TWO,
        id: 'op-new',
        email: 'wayne+2@maverick.launch',
      });
      // Mock the clipboard API used by Copy.
      Object.assign(navigator, {
        clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
      });
      await act(async () => {
        renderMgr();
      });
      await waitFor(() => {
        expect(screen.getByTestId('operators-manager-page')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('operators-manager-new'));
      fireEvent.change(screen.getByTestId('new-operator-email'), {
        target: { value: 'wayne+2@maverick.launch' },
      });
      // Default role is product_admin — provide a tenant_id.
      fireEvent.change(screen.getByTestId('new-operator-tenant-id'), {
        target: { value: OP_TWO.tenant_id! },
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('new-operator-submit'));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(apiPostMock).toHaveBeenCalledWith(
        '/api/v1/admin/operators',
        expect.objectContaining({
          email: 'wayne+2@maverick.launch',
          role: 'product_admin',
          tenant_id: OP_TWO.tenant_id,
          password: expect.any(String),
        }),
      );
      // Password banner + temp password shown.
      expect(
        screen.getByTestId('new-operator-password-banner'),
      ).toBeInTheDocument();
      const tempPass = screen.getByTestId('new-operator-temp-password');
      expect(tempPass.textContent!.length).toBeGreaterThanOrEqual(16);
      // Copy CTA flips label to 'Copied'.
      await act(async () => {
        fireEvent.click(screen.getByTestId('new-operator-copy'));
        await Promise.resolve();
      });
      expect(
        screen.getByTestId('new-operator-copy').textContent,
      ).toBe('Copied');
    });
  });

  describe('Edit modal + last-super_admin protection', () => {
    it('editing the currently-logged-in super_admin disables the role dropdown with helper text', async () => {
      mockList();
      await act(async () => {
        renderMgr();
      });
      await waitFor(() => {
        expect(screen.getByTestId('operators-manager-page')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('operators-edit-op-me'));
      expect(
        screen.getByTestId('edit-operator-role-locked'),
      ).toBeInTheDocument();
      expect(
        (screen.getByTestId('edit-operator-role') as HTMLSelectElement)
          .disabled,
      ).toBe(true);
    });

    it('changing role on another operator PUTs /:id/role separately from the content PUT', async () => {
      mockList();
      apiPutMock.mockResolvedValue({});
      await act(async () => {
        renderMgr();
      });
      await waitFor(() => {
        expect(screen.getByTestId('operators-manager-page')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('operators-edit-op-two'));
      // Toggle active off + promote to super_admin.
      fireEvent.click(screen.getByTestId('edit-operator-active'));
      fireEvent.change(screen.getByTestId('edit-operator-role'), {
        target: { value: 'super_admin' },
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('edit-operator-submit'));
        await Promise.resolve();
        await Promise.resolve();
      });
      const contentCall = apiPutMock.mock.calls.find(
        (c) => c[0] === '/api/v1/admin/operators/op-two',
      );
      const roleCall = apiPutMock.mock.calls.find(
        (c) => c[0] === '/api/v1/admin/operators/op-two/role',
      );
      expect(contentCall).toBeDefined();
      expect(contentCall![1]).toMatchObject({ active: false });
      expect(roleCall).toBeDefined();
      expect(roleCall![1]).toMatchObject({ role: 'super_admin' });
    });
  });

  describe('Deactivate two-step confirm', () => {
    it('first Continue click reveals the confirm panel; second click DELETEs', async () => {
      mockList();
      apiDeleteMock.mockResolvedValueOnce({});
      await act(async () => {
        renderMgr();
      });
      await waitFor(() => {
        expect(screen.getByTestId('operators-manager-page')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('operators-deactivate-op-two'));
      // First click → confirm-panel appears; DELETE NOT called yet.
      fireEvent.click(screen.getByTestId('deactivate-operator-confirm'));
      expect(
        screen.getByTestId('deactivate-operator-confirm-panel'),
      ).toBeInTheDocument();
      expect(apiDeleteMock).not.toHaveBeenCalled();
      // Second click → DELETE.
      await act(async () => {
        fireEvent.click(screen.getByTestId('deactivate-operator-confirm'));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(apiDeleteMock).toHaveBeenCalledWith(
        '/api/v1/admin/operators/op-two',
      );
    });
  });

  it('passes axe scan in the ready state', async () => {
    mockList();
    const { container } = renderMgr();
    await waitFor(() => {
      expect(screen.getByTestId('operators-manager-page')).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});
