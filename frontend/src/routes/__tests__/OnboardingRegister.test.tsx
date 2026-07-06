// Authorized by HUB-1397 (E-CMP-WAVE4 S4) — page-level tests for the Onboarding
// Register. Covers status filter default (Pending), status change, admin vs
// non-admin, Mark Complete confirmation flow (window.confirm → POST → refetch),
// and success toast.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import OnboardingRegister from '../OnboardingRegister';
import { useSessionStore } from '../../stores/sessionStore';
import { useToastStore } from '../../stores/toastStore';

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
vi.mock('../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
    post: (...args: unknown[]) => apiPostMock(...args),
  },
}));

const ROW = {
  id: '22222222-2222-2222-2222-222222222222',
  product_id: 'hub',
  employee_name: 'Ada Lovelace',
  employee_email: 'ada@x',
  role: 'eng',
  hire_date: '2026-07-01',
  sla_deadline: '2026-07-15',
  status: 'pending' as const,
  attested_by: null,
  completed_at: null,
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
};

function setSuperAdmin(): void {
  useSessionStore.setState({
    accessToken: 'jwt',
    refreshToken: 'refresh',
    operator: { id: 'op-1', email: 'sa@x', name: 'Super', role: 'super_admin' },
    isHydrating: false,
    isAuthenticated: true,
  });
}
function setProductAdmin(): void {
  useSessionStore.setState({
    accessToken: 'jwt',
    refreshToken: 'refresh',
    operator: { id: 'op-2', email: 'pa@x', name: 'Product', role: 'product_admin' },
    isHydrating: false,
    isAuthenticated: true,
  });
}

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={['/console/compliance/grc/onboarding']}>
      <OnboardingRegister />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  useToastStore.setState({ toasts: [] });
  apiGetMock.mockResolvedValue({ data: [ROW], total: 1, page: 1, pageSize: 50 });
});

afterEach(() => cleanup());

describe('OnboardingRegister — default filter + admin actions', () => {
  it('defaults status filter to pending', async () => {
    setSuperAdmin();
    renderPage();
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    expect((apiGetMock.mock.calls[0]![0] as string)).toContain('status=pending');
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('changes filter to All → drops status query param', async () => {
    setSuperAdmin();
    renderPage();
    await screen.findByText('Ada Lovelace');
    apiGetMock.mockClear();
    fireEvent.change(screen.getByTestId('onb-status-filter'), { target: { value: 'all' } });
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    expect((apiGetMock.mock.calls[0]![0] as string)).not.toContain('status=');
  });

  it('AC 5: Mark Complete → window.confirm YES → POST + success toast + refetch', async () => {
    setSuperAdmin();
    renderPage();
    await screen.findByText('Ada Lovelace');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    apiPostMock.mockResolvedValueOnce({ id: ROW.id, status: 'completed', completed_at: '2026-07-06T00:00:00Z' });
    apiGetMock.mockClear();
    apiGetMock.mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 50 });

    await act(async () => {
      fireEvent.click(screen.getByTestId(`onb-complete-btn-${ROW.id}`));
    });

    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith(`/api/v1/admin/grc/onboarding/${ROW.id}/complete`),
    );
    expect(useToastStore.getState().toasts[0]?.variant).toBe('success');
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    confirmSpy.mockRestore();
  });

  it('AC 5: Mark Complete → confirm CANCEL → no POST', async () => {
    setSuperAdmin();
    renderPage();
    await screen.findByText('Ada Lovelace');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByTestId(`onb-complete-btn-${ROW.id}`));
    expect(confirmSpy).toHaveBeenCalled();
    expect(apiPostMock).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});

describe('OnboardingRegister — non-admin (AC 8)', () => {
  it('hides Add + Mark Complete for product_admin', async () => {
    setProductAdmin();
    renderPage();
    await screen.findByText('Ada Lovelace');
    expect(screen.queryByTestId('add-onb-button')).toBeNull();
    expect(screen.queryByTestId(`onb-complete-btn-${ROW.id}`)).toBeNull();
  });
});
