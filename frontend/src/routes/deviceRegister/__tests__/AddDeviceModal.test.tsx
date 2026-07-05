// Authorized by HUB-1396 (E-CMP-WAVE4 S3) — AddDeviceModal tests. Covers AC 4:
// required-field validation, successful POST + success toast + onCreated invocation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AddDeviceModal } from '../AddDeviceModal';
import { useToastStore } from '../../../stores/toastStore';

const apiPostMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: { post: (...args: unknown[]) => apiPostMock(...args) },
}));

beforeEach(() => {
  apiPostMock.mockReset();
  useToastStore.setState({ toasts: [] });
});

afterEach(() => cleanup());

describe('AddDeviceModal (AC 4)', () => {
  it('validates required fields — blank product_id blocks submission', async () => {
    render(<AddDeviceModal onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByTestId('add-device-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('add-device-product-id')).toHaveAttribute('aria-invalid', 'true'),
    );
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it('successful submit posts payload + success toast + onCreated called', async () => {
    const onCreated = vi.fn();
    apiPostMock.mockResolvedValueOnce({ id: 'dev-1', product_id: 'hub', device_name: 'MBP-1' });
    render(<AddDeviceModal onClose={() => {}} onCreated={onCreated} />);
    fireEvent.change(screen.getByTestId('add-device-product-id'), { target: { value: 'hub' } });
    fireEvent.change(screen.getByTestId('add-device-name'), { target: { value: 'MBP-1' } });
    fireEvent.change(screen.getByTestId('add-device-owner-name'), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByTestId('add-device-owner-email'), { target: { value: 'ada@x' } });
    fireEvent.click(screen.getByTestId('add-device-submit'));

    await waitFor(() => expect(apiPostMock).toHaveBeenCalled());
    const [url, body] = apiPostMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/admin/grc/devices');
    expect(body).toMatchObject({
      product_id: 'hub',
      device_name: 'MBP-1',
      owner_name: 'Ada',
      owner_email: 'ada@x',
    });
    await waitFor(() => expect(useToastStore.getState().toasts[0]?.variant).toBe('success'));
    expect(onCreated).toHaveBeenCalled();
  });

  // Error-toast path is covered by the higher-level DeviceRegister page test's
  // load-failure branch + the AttestDeviceModal error toast test.
});
