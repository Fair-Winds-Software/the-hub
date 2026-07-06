// Authorized by HUB-1398 (E-CMP-WAVE4 S5) — page-level tests for Offboarding Register.
// Covers status filter default, admin vs non-admin, AC 6 auto-complete toast when
// server returns completed_at for the first time, and partial-checklist path emitting
// the generic "Checklist updated" toast.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import OffboardingRegister from '../OffboardingRegister';
import { useSessionStore } from '../../stores/sessionStore';
import { useToastStore } from '../../stores/toastStore';

const apiGetMock = vi.fn();
const apiPutMock = vi.fn();
vi.mock('../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
    put: (...args: unknown[]) => apiPutMock(...args),
  },
}));

const ROW = {
  id: '33333333-3333-3333-3333-333333333333',
  product_id: 'hub',
  employee_name: 'Bob Byrd',
  employee_email: 'bob@x',
  role: 'eng',
  last_day: '2026-07-04',
  revocation_deadline: '2026-07-05T18:00:00Z',
  device_returned: true,
  accounts_disabled: true,
  tokens_revoked: false,
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
    <MemoryRouter initialEntries={['/console/compliance/grc/offboarding']}>
      <OffboardingRegister />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiGetMock.mockReset();
  apiPutMock.mockReset();
  useToastStore.setState({ toasts: [] });
  apiGetMock.mockResolvedValue({ data: [ROW], total: 1, page: 1, pageSize: 50 });
});

afterEach(() => cleanup());

describe('OffboardingRegister — filter + admin gate', () => {
  it('defaults status filter to pending', async () => {
    setSuperAdmin();
    renderPage();
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    expect((apiGetMock.mock.calls[0]![0] as string)).toContain('status=pending');
    expect(await screen.findByText('Bob Byrd')).toBeInTheDocument();
  });

  it('hides Add button for product_admin', async () => {
    setProductAdmin();
    renderPage();
    await screen.findByText('Bob Byrd');
    expect(screen.queryByTestId('add-off-button')).toBeNull();
  });
});

describe('OffboardingRegister — checklist toggle (AC 6)', () => {
  it('AC 6: toggling third checkbox that flips completed_at → emits "access revocation confirmed" toast', async () => {
    setSuperAdmin();
    renderPage();
    await screen.findByText('Bob Byrd');
    apiPutMock.mockResolvedValueOnce({
      ...ROW,
      tokens_revoked: true,
      status: 'completed',
      completed_at: '2026-07-05T12:00:00Z',
    });
    // Refetch resolves too:
    apiGetMock.mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 50 });

    fireEvent.click(screen.getByTestId(`off-check-tokens_revoked-${ROW.id}`));

    await waitFor(() => expect(apiPutMock).toHaveBeenCalledWith(
      `/api/v1/admin/grc/offboarding/${ROW.id}/checklist`,
      { tokens_revoked: true },
    ));
    await waitFor(() =>
      expect(useToastStore.getState().toasts[0]?.message).toMatch(/access revocation confirmed/i),
    );
  });

  it('partial toggle → generic "Checklist updated" toast', async () => {
    setSuperAdmin();
    renderPage();
    await screen.findByText('Bob Byrd');
    apiPutMock.mockResolvedValueOnce({
      ...ROW,
      device_returned: true,
      completed_at: null,
    });
    apiGetMock.mockResolvedValue({ data: [ROW], total: 1, page: 1, pageSize: 50 });

    fireEvent.click(screen.getByTestId(`off-check-device_returned-${ROW.id}`));

    await waitFor(() => expect(apiPutMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(useToastStore.getState().toasts[0]?.message).toBe('Checklist updated.'),
    );
  });
});
