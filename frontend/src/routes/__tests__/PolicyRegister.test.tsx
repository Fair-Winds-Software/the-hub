// Authorized by HUB-1438 (E-CMP-WAVE4b S5) — page-level tests for Policy Register.
// Special AC: acknowledge is accessible to BOTH super_admin and product_admin (per
// HUB-1423 AC 13 — employee self-service).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PolicyRegister from '../PolicyRegister';
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
  id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  policy_name: 'Acceptable Use',
  policy_type: 'acceptable_use' as const,
  version: 'v1.0',
  effective_date: '2026-01-01',
  review_due_date: '2027-01-01',
  review_frequency_days: 365,
  owner_id: 'sammy',
  status: 'active' as const,
  document_url: null,
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
    <MemoryRouter initialEntries={['/console/compliance/grc/policies']}>
      <PolicyRegister />
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

describe('PolicyRegister — filter + role gating', () => {
  it('defaults status filter to active + renders policy row', async () => {
    setSuperAdmin();
    renderPage();
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    expect((apiGetMock.mock.calls[0]![0] as string)).toContain('status=active');
    expect(await screen.findByText('Acceptable Use')).toBeInTheDocument();
    expect(screen.getByText('v1.0')).toBeInTheDocument();
  });

  it('policy_type filter change refetches with new param', async () => {
    setSuperAdmin();
    renderPage();
    await screen.findByText('Acceptable Use');
    apiGetMock.mockClear();
    fireEvent.change(screen.getByTestId('policy-type-filter'), { target: { value: 'security' } });
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    expect((apiGetMock.mock.calls[0]![0] as string)).toContain('policy_type=security');
  });

  it('AC 13: acknowledge button visible for BOTH super_admin and product_admin', async () => {
    setSuperAdmin();
    renderPage();
    await screen.findByText('Acceptable Use');
    expect(screen.getByTestId(`policy-ack-btn-${ROW.id}`)).toBeInTheDocument();
    cleanup();

    setProductAdmin();
    renderPage();
    await screen.findByText('Acceptable Use');
    expect(screen.getByTestId(`policy-ack-btn-${ROW.id}`)).toBeInTheDocument();
  });

  it('AC 13: Add Policy button visible only for super_admin', async () => {
    setSuperAdmin();
    renderPage();
    await screen.findByText('Acceptable Use');
    expect(screen.getByTestId('add-policy-button')).toBeInTheDocument();
    cleanup();

    setProductAdmin();
    renderPage();
    await screen.findByText('Acceptable Use');
    expect(screen.queryByTestId('add-policy-button')).toBeNull();
  });

  it('acknowledge submit posts payload + success toast', async () => {
    setProductAdmin();
    renderPage();
    await screen.findByText('Acceptable Use');
    apiPostMock.mockResolvedValueOnce({ id: 'ack-1' });
    fireEvent.click(screen.getByTestId(`policy-ack-btn-${ROW.id}`));
    expect(await screen.findByTestId('ack-policy-modal')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('ack-employee-id'), { target: { value: 'emp-42' } });
    fireEvent.change(screen.getByTestId('ack-employee-name'), { target: { value: 'Ada L.' } });
    fireEvent.click(screen.getByTestId('ack-submit'));
    await waitFor(() => expect(apiPostMock).toHaveBeenCalledWith(
      `/api/v1/admin/grc/policies/${ROW.id}/acknowledge`,
      { employee_id: 'emp-42', employee_name: 'Ada L.', policy_version: 'v1.0' },
    ));
    await waitFor(() => expect(useToastStore.getState().toasts[0]?.variant).toBe('success'));
  });
});
