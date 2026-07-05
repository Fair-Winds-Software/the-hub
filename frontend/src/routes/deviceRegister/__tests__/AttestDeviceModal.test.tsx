// Authorized by HUB-1396 (E-CMP-WAVE4 S3) — attest modal tests.
// Covers AC 5: compliant submit does NOT show the signal-suppression note; non-compliant
// selection surfaces the note before submit. Submit posts the right payload; success toast
// + onAttested called.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AttestDeviceModal } from '../AttestDeviceModal';
import { useToastStore } from '../../../stores/toastStore';

const apiPostMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: { post: (...args: unknown[]) => apiPostMock(...args) },
}));

const DEVICE = {
  id: '11111111-1111-1111-1111-111111111111',
  product_id: 'hub',
  device_name: 'MBP-Ada',
  owner_name: 'Ada',
  owner_email: 'ada@x',
  model: null,
  serial_number: null,
  enrollment_date: null,
  status: 'active' as const,
  decommissioned_at: null,
  added_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
};

beforeEach(() => {
  apiPostMock.mockReset();
  useToastStore.setState({ toasts: [] });
});

afterEach(() => cleanup());

describe('AttestDeviceModal (AC 5, AC 13)', () => {
  it('AC 13 UX: selecting non-compliant reveals the signal-suppression note', () => {
    render(
      <AttestDeviceModal device={DEVICE} onClose={() => {}} onAttested={() => {}} />,
    );
    expect(screen.queryByTestId('attest-noncompliant-note')).toBeNull();
    fireEvent.change(screen.getByTestId('attest-status'), {
      target: { value: 'non_compliant' },
    });
    expect(screen.getByTestId('attest-noncompliant-note')).toBeInTheDocument();
  });

  it('AC 5: compliant submit posts the right payload + success toast + onAttested called', async () => {
    const onAttested = vi.fn();
    apiPostMock.mockResolvedValueOnce({ id: 'rec-1' });
    render(
      <AttestDeviceModal device={DEVICE} onClose={() => {}} onAttested={onAttested} />,
    );
    fireEvent.change(screen.getByTestId('attest-compliance-type'), {
      target: { value: 'disk_encryption' },
    });
    fireEvent.change(screen.getByTestId('attest-attested-by'), {
      target: { value: 'it-lead@x' },
    });
    fireEvent.click(screen.getByTestId('attest-submit'));

    await waitFor(() => expect(apiPostMock).toHaveBeenCalled());
    expect(apiPostMock).toHaveBeenCalledWith(
      `/api/v1/admin/grc/devices/${DEVICE.id}/compliance`,
      { compliance_type: 'disk_encryption', status: 'compliant', attested_by: 'it-lead@x' },
    );
    expect(useToastStore.getState().toasts[0]?.variant).toBe('success');
    await waitFor(() => expect(onAttested).toHaveBeenCalled());
  });

  it('surfaces validation error when attested_by is blank', async () => {
    render(
      <AttestDeviceModal device={DEVICE} onClose={() => {}} onAttested={() => {}} />,
    );
    fireEvent.click(screen.getByTestId('attest-submit'));
    expect(await screen.findByText(/Attested by is required/)).toBeInTheDocument();
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it('error toast on API failure', async () => {
    apiPostMock.mockRejectedValueOnce(new Error('backend down'));
    render(
      <AttestDeviceModal device={DEVICE} onClose={() => {}} onAttested={() => {}} />,
    );
    fireEvent.change(screen.getByTestId('attest-attested-by'), {
      target: { value: 'auditor@x' },
    });
    fireEvent.click(screen.getByTestId('attest-submit'));
    await waitFor(() => expect(useToastStore.getState().toasts[0]?.variant).toBe('error'));
  });

  it('ESC key closes the modal', () => {
    const onClose = vi.fn();
    render(<AttestDeviceModal device={DEVICE} onClose={onClose} onAttested={() => {}} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
