// Authorized by HUB-1436 (E-CMP-WAVE4b S3) — page-level tests for Vendor Register.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import VendorRegister from '../VendorRegister';
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

const ROW = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  vendor_name: 'Acme SaaS',
  vendor_type: 'saas' as const,
  website: 'https://acme.example',
  contract_start_date: null,
  contract_end_date: null,
  data_access_level: 'limited' as const,
  risk_level: 'medium' as const,
  last_reviewed_at: null,
  next_review_due: '2026-09-01',
  review_frequency_days: 90,
  status: 'active' as const,
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
};

function setSuperAdmin(): void {
  useSessionStore.setState({
    accessToken: 'jwt', refreshToken: 'refresh',
    operator: { id: 'op-1', email: 'sa@x', name: 'Super', role: 'super_admin' },
    isHydrating: false, isAuthenticated: true,
  });
}
function setProductAdmin(): void {
  useSessionStore.setState({
    accessToken: 'jwt', refreshToken: 'refresh',
    operator: { id: 'op-2', email: 'pa@x', name: 'Product', role: 'product_admin' },
    isHydrating: false, isAuthenticated: true,
  });
}

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={['/console/compliance/grc/vendors']}>
      <VendorRegister />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  apiDeleteMock.mockReset();
  useToastStore.setState({ toasts: [] });
  apiGetMock.mockResolvedValue({ data: [ROW], total: 1, page: 1, pageSize: 50 });
});

afterEach(() => cleanup());

describe('VendorRegister — super_admin', () => {
  it('defaults status filter to active + renders vendor row + risk badge', async () => {
    setSuperAdmin();
    renderPage();
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    expect((apiGetMock.mock.calls[0]![0] as string)).toContain('status=active');
    expect(await screen.findByText('Acme SaaS')).toBeInTheDocument();
    expect(screen.getByTestId('vendor-risk-medium')).toBeInTheDocument();
    expect(screen.getByTestId('vendor-status-pill-active')).toBeInTheDocument();
  });

  it('risk filter change refetches + resets page', async () => {
    setSuperAdmin();
    renderPage();
    await screen.findByText('Acme SaaS');
    apiGetMock.mockClear();
    fireEvent.change(screen.getByTestId('vendor-risk-filter'), { target: { value: 'high' } });
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    expect((apiGetMock.mock.calls[0]![0] as string)).toContain('risk_level=high');
    expect((apiGetMock.mock.calls[0]![0] as string)).toContain('page=1');
  });

  it('archive → window.confirm YES → DELETE + success toast + refetch', async () => {
    setSuperAdmin();
    renderPage();
    await screen.findByText('Acme SaaS');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    apiDeleteMock.mockResolvedValueOnce({ id: ROW.id, status: 'archived' });
    apiGetMock.mockClear();
    apiGetMock.mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 50 });

    await act(async () => {
      fireEvent.click(screen.getByTestId(`vendor-archive-btn-${ROW.id}`));
    });

    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(apiDeleteMock).toHaveBeenCalledWith(`/api/v1/admin/grc/vendors/${ROW.id}`));
    expect(useToastStore.getState().toasts[0]?.variant).toBe('success');
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    confirmSpy.mockRestore();
  });

  it('archive → confirm CANCEL → no DELETE', async () => {
    setSuperAdmin();
    renderPage();
    await screen.findByText('Acme SaaS');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByTestId(`vendor-archive-btn-${ROW.id}`));
    expect(apiDeleteMock).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});

describe('VendorRegister — non-admin', () => {
  it('hides Add + Assess + Archive for product_admin', async () => {
    setProductAdmin();
    renderPage();
    await screen.findByText('Acme SaaS');
    expect(screen.queryByTestId('add-vendor-button')).toBeNull();
    expect(screen.queryByTestId(`vendor-assess-btn-${ROW.id}`)).toBeNull();
    expect(screen.queryByTestId(`vendor-archive-btn-${ROW.id}`)).toBeNull();
  });
});
