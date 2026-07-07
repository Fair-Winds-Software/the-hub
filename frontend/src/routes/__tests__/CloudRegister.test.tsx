// Authorized by HUB-1437 (E-CMP-WAVE4b S4) — page-level tests for Cloud Register.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CloudRegister from '../CloudRegister';
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
  id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  account_name: 'prod-us-east',
  provider: 'aws' as const,
  account_id: '1234567890',
  environment: 'production' as const,
  service_type: 'ec2',
  owner_id: 'ops-lead',
  security_score: 72,
  last_audited_at: null,
  next_audit_due: '2026-10-01',
  audit_frequency_days: 90,
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
    <MemoryRouter initialEntries={['/console/compliance/grc/cloud']}>
      <CloudRegister />
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

describe('CloudRegister — filter + admin gate', () => {
  it('defaults status filter to active + renders cloud account with security score', async () => {
    setSuperAdmin();
    renderPage();
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    expect((apiGetMock.mock.calls[0]![0] as string)).toContain('status=active');
    expect(await screen.findByText('prod-us-east')).toBeInTheDocument();
    expect(screen.getByTestId('cloud-security-score').textContent).toBe('72');
  });

  it('provider filter change refetches with new param', async () => {
    setSuperAdmin();
    renderPage();
    await screen.findByText('prod-us-east');
    apiGetMock.mockClear();
    fireEvent.change(screen.getByTestId('cloud-provider-filter'), { target: { value: 'aws' } });
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    expect((apiGetMock.mock.calls[0]![0] as string)).toContain('provider=aws');
  });

  it('hides Add + Attest for product_admin', async () => {
    setProductAdmin();
    renderPage();
    await screen.findByText('prod-us-east');
    expect(screen.queryByTestId('add-cloud-button')).toBeNull();
    expect(screen.queryByTestId(`cloud-attest-btn-${ROW.id}`)).toBeNull();
  });

  it('AC 14 UX (via AttestCloudModal): opening attest modal, selecting fail reveals the signal-suppression note', async () => {
    setSuperAdmin();
    renderPage();
    await screen.findByText('prod-us-east');
    fireEvent.click(screen.getByTestId(`cloud-attest-btn-${ROW.id}`));
    expect(await screen.findByTestId('attest-cloud-modal')).toBeInTheDocument();
    expect(screen.queryByTestId('attest-cloud-nonpass-note')).toBeNull();
    fireEvent.change(screen.getByTestId('attest-cloud-status'), { target: { value: 'fail' } });
    expect(screen.getByTestId('attest-cloud-nonpass-note')).toBeInTheDocument();
    // switching back to pass hides it
    fireEvent.change(screen.getByTestId('attest-cloud-status'), { target: { value: 'pass' } });
    expect(screen.queryByTestId('attest-cloud-nonpass-note')).toBeNull();
  });
});
