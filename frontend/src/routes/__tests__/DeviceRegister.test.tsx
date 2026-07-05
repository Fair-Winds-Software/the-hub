// Authorized by HUB-1396 (E-CMP-WAVE4 S3) — page-level tests for the Device Register.
// Covers: table render, status filter change, page/pageSize controls, super_admin gate
// on Add Device + row actions, decommission confirm flow (window.confirm) + success toast.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DeviceRegister from '../DeviceRegister';
import { useSessionStore } from '../../stores/sessionStore';
import { useToastStore } from '../../stores/toastStore';

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
const apiDeleteMock = vi.fn();
vi.mock('../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
    post: (...args: unknown[]) => apiPostMock(...args),
    delete: (...args: unknown[]) => apiDeleteMock(...args),
  },
}));

const ROW_1 = {
  id: '11111111-1111-1111-1111-111111111111',
  product_id: 'hub',
  device_name: 'MBP-Ada',
  owner_name: 'Ada Lovelace',
  owner_email: 'ada@x',
  model: 'MacBook Pro 14',
  serial_number: 'SN-1',
  enrollment_date: '2026-06-01',
  status: 'active' as const,
  decommissioned_at: null,
  added_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
};

function setSuperAdmin(): void {
  useSessionStore.setState({
    accessToken: 'jwt',
    refreshToken: 'refresh',
    operator: { id: 'op-1', email: 'sa@x', name: 'Super Admin', role: 'super_admin' },
    isHydrating: false,
    isAuthenticated: true,
  });
}
function setProductAdmin(): void {
  useSessionStore.setState({
    accessToken: 'jwt',
    refreshToken: 'refresh',
    operator: { id: 'op-2', email: 'pa@x', name: 'Product Admin', role: 'product_admin' },
    isHydrating: false,
    isAuthenticated: true,
  });
}

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={['/console/compliance/grc/devices']}>
      <DeviceRegister />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  apiDeleteMock.mockReset();
  useToastStore.setState({ toasts: [] });
  apiGetMock.mockResolvedValue({ data: [ROW_1], total: 1, page: 1, pageSize: 50 });
});

afterEach(() => {
  cleanup();
});

describe('DeviceRegister page — super_admin view (AC 1, 4, 6, 8, 9, 10)', () => {
  it('renders the header, table with device row, and status filter defaults to active', async () => {
    setSuperAdmin();
    renderPage();
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    expect((apiGetMock.mock.calls[0]![0] as string)).toContain('status=active');
    expect(await screen.findByText('MBP-Ada')).toBeInTheDocument();
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByTestId('status-pill-active')).toBeInTheDocument();
  });

  it('shows Add Device button + row actions for super_admin', async () => {
    setSuperAdmin();
    renderPage();
    await screen.findByText('MBP-Ada');
    expect(screen.getByTestId('add-device-button')).toBeInTheDocument();
    expect(screen.getByTestId(`attest-btn-${ROW_1.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`decommission-btn-${ROW_1.id}`)).toBeInTheDocument();
  });

  it('changes status filter → refetches with new query param + resets to page 1', async () => {
    setSuperAdmin();
    renderPage();
    await screen.findByText('MBP-Ada');
    apiGetMock.mockClear();
    apiGetMock.mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 50 });
    fireEvent.change(screen.getByTestId('device-status-filter'), { target: { value: 'decommissioned' } });
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    expect((apiGetMock.mock.calls[0]![0] as string)).toContain('status=decommissioned');
    expect((apiGetMock.mock.calls[0]![0] as string)).toContain('page=1');
  });

  it('"All" filter drops the status param', async () => {
    setSuperAdmin();
    renderPage();
    await screen.findByText('MBP-Ada');
    apiGetMock.mockClear();
    fireEvent.change(screen.getByTestId('device-status-filter'), { target: { value: 'all' } });
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    expect((apiGetMock.mock.calls[0]![0] as string)).not.toContain('status=');
  });

  it('page size selector updates pageSize query param', async () => {
    setSuperAdmin();
    renderPage();
    await screen.findByText('MBP-Ada');
    apiGetMock.mockClear();
    fireEvent.change(screen.getByTestId('device-page-size'), { target: { value: '100' } });
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    expect((apiGetMock.mock.calls[0]![0] as string)).toContain('pageSize=100');
  });

  it('AC 6: decommission → window.confirm YES → DELETE called + success toast + refetch', async () => {
    setSuperAdmin();
    renderPage();
    await screen.findByText('MBP-Ada');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    apiDeleteMock.mockResolvedValueOnce({ id: ROW_1.id, decommissioned_at: '2026-07-05T12:00:00Z' });
    apiGetMock.mockClear();
    apiGetMock.mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 50 });

    await act(async () => {
      fireEvent.click(screen.getByTestId(`decommission-btn-${ROW_1.id}`));
    });

    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() =>
      expect(apiDeleteMock).toHaveBeenCalledWith(`/api/v1/admin/grc/devices/${ROW_1.id}`),
    );
    expect(useToastStore.getState().toasts[0]?.variant).toBe('success');
    expect(useToastStore.getState().toasts[0]?.message).toMatch(/decommissioned/i);
    // refetch fires
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    confirmSpy.mockRestore();
  });

  it('AC 6: decommission → window.confirm CANCEL → no DELETE, no toast', async () => {
    setSuperAdmin();
    renderPage();
    await screen.findByText('MBP-Ada');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByTestId(`decommission-btn-${ROW_1.id}`));
    expect(confirmSpy).toHaveBeenCalled();
    expect(apiDeleteMock).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toHaveLength(0);
    confirmSpy.mockRestore();
  });
});

describe('DeviceRegister page — non-admin read-only (AC 9)', () => {
  it('hides Add Device + row action buttons for product_admin', async () => {
    setProductAdmin();
    renderPage();
    await screen.findByText('MBP-Ada');
    expect(screen.queryByTestId('add-device-button')).toBeNull();
    expect(screen.queryByTestId(`attest-btn-${ROW_1.id}`)).toBeNull();
    expect(screen.queryByTestId(`decommission-btn-${ROW_1.id}`)).toBeNull();
  });
});

describe('DeviceRegister page — empty + error branches', () => {
  it('renders empty state when total=0', async () => {
    setSuperAdmin();
    apiGetMock.mockResolvedValueOnce({ data: [], total: 0, page: 1, pageSize: 50 });
    renderPage();
    expect(await screen.findByTestId('device-table-empty')).toBeInTheDocument();
  });

  it('renders error message on load failure', async () => {
    setSuperAdmin();
    apiGetMock.mockRejectedValueOnce(new Error('boom'));
    renderPage();
    expect(await screen.findByTestId('device-error')).toHaveTextContent(/boom/);
  });
});
