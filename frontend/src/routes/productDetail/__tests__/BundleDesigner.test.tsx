// Authorized by HUB-1723 (E-V2-PP-1 S10, HUB-1713, HUB-1701) —
// BundleDesigner route tests. Covers list load, empty state, new-bundle
// modal validation, archive two-step confirm, and the exported
// validateNewBundle pure function.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import BundleDesigner, { validateNewBundle } from '../BundleDesigner';

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
const apiPutMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
    post: (...args: unknown[]) => apiPostMock(...args),
    put: (...args: unknown[]) => apiPutMock(...args),
  },
}));

const PLANS = [
  { id: 'plan-mobile', key: 'mobile', name: 'Mobile' },
  { id: 'plan-desktop', key: 'desktop', name: 'Desktop' },
];

const BUNDLE_ACTIVE = {
  id: 'bundle-1',
  product_id: 'prod-1',
  bundle_name: 'Full Stack',
  member_plan_ids: ['plan-mobile', 'plan-desktop'],
  discount_type: 'flat_amount_cents' as const,
  discount_value: 50000,
  status: 'active' as const,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

function mountRoute(): void {
  render(
    <MemoryRouter initialEntries={['/console/products/prod-1/pricing/bundles']}>
      <Routes>
        <Route
          path="/console/products/:productId/pricing/bundles"
          element={<BundleDesigner />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  apiPutMock.mockReset();
  apiGetMock.mockImplementation((path: string) => {
    if (path.startsWith('/api/v1/admin/plan_bundles')) {
      return Promise.resolve({ data: [BUNDLE_ACTIVE], total: 1 });
    }
    if (path.startsWith('/api/v1/admin/plans')) {
      return Promise.resolve({ data: PLANS, total: PLANS.length });
    }
    return Promise.resolve({ data: [], total: 0 });
  });
});

afterEach(() => cleanup());

// ── HUB-1723 (S10) route + list + interactions ─────────────────────────────
describe('HUB-1723 (S10): BundleDesigner route', () => {
  it('renders the loading indicator then the bundle list (AC 1)', async () => {
    mountRoute();
    expect(screen.getByTestId('bundle-loading')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId(`bundle-row-${BUNDLE_ACTIVE.id}`)).toBeInTheDocument());
    expect(screen.getByText('Full Stack')).toBeInTheDocument();
    // Members render as "Mobile, Desktop" joined; assert on the row text content.
    const row = screen.getByTestId(`bundle-row-${BUNDLE_ACTIVE.id}`);
    expect(row.textContent).toMatch(/Mobile/);
    expect(row.textContent).toMatch(/Desktop/);
  });

  it('shows empty state when no bundles', async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path.startsWith('/api/v1/admin/plan_bundles')) {
        return Promise.resolve({ data: [], total: 0 });
      }
      return Promise.resolve({ data: PLANS, total: PLANS.length });
    });
    mountRoute();
    await waitFor(() => expect(screen.getByTestId('bundle-empty')).toBeInTheDocument());
    expect(screen.getByTestId('bundle-empty')).toHaveTextContent(/no bundles yet/i);
  });

  it('opens the archive dialog with 2-step confirm (AC 5)', async () => {
    mountRoute();
    await waitFor(() => screen.getByTestId(`bundle-archive-${BUNDLE_ACTIVE.id}`));
    fireEvent.click(screen.getByTestId(`bundle-archive-${BUNDLE_ACTIVE.id}`));
    expect(screen.getByTestId('archive-bundle-dialog')).toBeInTheDocument();
    apiPutMock.mockResolvedValueOnce({});
    fireEvent.click(screen.getByTestId('archive-bundle-confirm'));
    await waitFor(() => expect(apiPutMock).toHaveBeenCalledWith(
      `/api/v1/admin/plan_bundles/${BUNDLE_ACTIVE.id}`,
      { status: 'archived' },
    ));
  });

  it('opens the New Bundle modal and validates before submit (AC 2/3)', async () => {
    mountRoute();
    await waitFor(() => screen.getByTestId('new-bundle-button'));
    fireEvent.click(screen.getByTestId('new-bundle-button'));
    expect(screen.getByTestId('new-bundle-modal')).toBeInTheDocument();

    // Submit disabled by default (empty name, no members, no value).
    expect(screen.getByTestId('new-bundle-submit')).toBeDisabled();

    // Fill valid state.
    fireEvent.change(screen.getByTestId('new-bundle-name'), { target: { value: 'Full Stack' } });
    fireEvent.click(screen.getByTestId(`new-bundle-member-${PLANS[0]!.id}`));
    fireEvent.click(screen.getByTestId(`new-bundle-member-${PLANS[1]!.id}`));
    fireEvent.change(screen.getByTestId('new-bundle-discount-value'), { target: { value: '50000' } });

    apiPostMock.mockResolvedValueOnce({});
    fireEvent.click(screen.getByTestId('new-bundle-submit'));
    await waitFor(() => expect(apiPostMock).toHaveBeenCalledWith(
      '/api/v1/admin/plan_bundles',
      expect.objectContaining({
        product_id: 'prod-1',
        bundle_name: 'Full Stack',
        member_plan_ids: [PLANS[0]!.id, PLANS[1]!.id],
        discount_type: 'flat_amount_cents',
        discount_value: 50000,
      }),
    ));
  });
});

// ── validateNewBundle pure function ────────────────────────────────────────
describe('validateNewBundle', () => {
  const base = {
    bundle_name: 'Full Stack',
    member_plan_ids: ['a', 'b'],
    discount_type: 'flat_amount_cents' as const,
    discount_value: '500',
  };

  it('accepts a valid draft', () => {
    expect(validateNewBundle(base)).toEqual({});
  });

  it('rejects bundle_name < 3 chars (AC 3)', () => {
    expect(validateNewBundle({ ...base, bundle_name: 'ab' })).toEqual({
      bundle_name: expect.stringMatching(/≥ 3/i),
    });
  });

  it('rejects fewer than 2 members (AC 3)', () => {
    expect(validateNewBundle({ ...base, member_plan_ids: ['only-one'] })).toEqual({
      member_plan_ids: expect.stringMatching(/at least 2/i),
    });
  });

  it('rejects negative discount_value', () => {
    expect(validateNewBundle({ ...base, discount_value: '-100' })).toEqual({
      discount_value: expect.stringMatching(/non-negative/i),
    });
  });

  it('rejects percent_bps > 10000 (AC 3)', () => {
    expect(
      validateNewBundle({ ...base, discount_type: 'percent_bps', discount_value: '10001' }),
    ).toEqual({
      discount_value: expect.stringMatching(/10000/),
    });
  });

  it('accepts percent_bps at exact upper bound 10000', () => {
    expect(
      validateNewBundle({ ...base, discount_type: 'percent_bps', discount_value: '10000' }),
    ).toEqual({});
  });
});
