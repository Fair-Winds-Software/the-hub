// Authorized by HUB-1396 (E-CMP-WAVE4 S3) — DeviceTable unit tests. Covers AC 2
// (status badge variants) + AC 9 (actions absent when isAdmin=false).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DeviceTable } from '../DeviceTable';
import type { DeviceRow } from '../types';

const baseRow: DeviceRow = {
  id: '11111111-1111-1111-1111-111111111111',
  product_id: 'hub',
  device_name: 'MBP-Ada',
  owner_name: 'Ada',
  owner_email: 'ada@x',
  model: 'MBP',
  serial_number: 'SN-1',
  enrollment_date: '2026-06-01',
  status: 'active',
  decommissioned_at: null,
  added_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
};

afterEach(() => cleanup());

describe('DeviceTable (AC 2, 9)', () => {
  it('renders active status pill with success styling', () => {
    render(
      <DeviceTable rows={[baseRow]} isAdmin={false} onAttest={vi.fn()} onDecommission={vi.fn()} />,
    );
    const pill = screen.getByTestId('status-pill-active');
    expect(pill).toBeInTheDocument();
    expect(pill.className).toMatch(/success-forest/);
  });

  it('renders decommissioned status pill with muted styling', () => {
    render(
      <DeviceTable
        rows={[{ ...baseRow, status: 'decommissioned', decommissioned_at: '2026-07-05T00:00:00Z' }]}
        isAdmin={false}
        onAttest={vi.fn()}
        onDecommission={vi.fn()}
      />,
    );
    expect(screen.getByTestId('status-pill-decommissioned')).toBeInTheDocument();
  });

  it('AC 9: hides Actions column entirely for non-admin', () => {
    render(
      <DeviceTable rows={[baseRow]} isAdmin={false} onAttest={vi.fn()} onDecommission={vi.fn()} />,
    );
    expect(screen.queryByTestId(`attest-btn-${baseRow.id}`)).toBeNull();
    expect(screen.queryByTestId(`decommission-btn-${baseRow.id}`)).toBeNull();
  });

  it('AC 9: shows Attest + Decommission buttons for admin on active rows', () => {
    render(
      <DeviceTable rows={[baseRow]} isAdmin={true} onAttest={vi.fn()} onDecommission={vi.fn()} />,
    );
    expect(screen.getByTestId(`attest-btn-${baseRow.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`decommission-btn-${baseRow.id}`)).toBeInTheDocument();
  });

  it('decommissioned rows have no action buttons even for admin', () => {
    render(
      <DeviceTable
        rows={[{ ...baseRow, status: 'decommissioned' }]}
        isAdmin={true}
        onAttest={vi.fn()}
        onDecommission={vi.fn()}
      />,
    );
    expect(screen.queryByTestId(`attest-btn-${baseRow.id}`)).toBeNull();
    expect(screen.queryByTestId(`decommission-btn-${baseRow.id}`)).toBeNull();
  });

  it('empty rows → empty state banner', () => {
    render(<DeviceTable rows={[]} isAdmin={true} onAttest={vi.fn()} onDecommission={vi.fn()} />);
    expect(screen.getByTestId('device-table-empty')).toBeInTheDocument();
  });
});
