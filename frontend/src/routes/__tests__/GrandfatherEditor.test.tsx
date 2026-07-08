// Authorized by HUB-1755/1756/1757 (E-V2-PP-4 S6/S7/S8, HUB-1728, HUB-1701) — frontend
// tests for UpgradeBanner + GrandfatherEditor + RenewalPreview + validateGrandfather.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  UpgradeBanner,
  GrandfatherEditor,
  RenewalPreview,
  validateGrandfather,
} from '../GrandfatherEditor';

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
vi.mock('../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
    post: (...args: unknown[]) => apiPostMock(...args),
  },
}));

const TENANT_ID = 'tenant-1';
const PRODUCT_ID = 'prod-1';

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
});
afterEach(() => cleanup());

// ── HUB-1755 (S6): UpgradeBanner ──────────────────────────────────────────
describe('HUB-1755 (S6): UpgradeBanner', () => {
  it('renders nothing when no active suggestion', async () => {
    apiGetMock.mockResolvedValue({ suggestion: null });
    const { container } = render(<UpgradeBanner tenantId={TENANT_ID} productId={PRODUCT_ID} />);
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="upgrade-banner"]')).toBeNull();
  });

  it('renders with savings copy when suggestion exists (AC 2)', async () => {
    apiGetMock.mockResolvedValue({
      suggestion: {
        id: 's1', tenant_id: TENANT_ID, product_id: PRODUCT_ID,
        suggested_tier_index: 1, projected_savings_cents: 5000,
      },
    });
    render(<UpgradeBanner tenantId={TENANT_ID} productId={PRODUCT_ID} />);
    await waitFor(() => expect(screen.getByTestId('upgrade-banner')).toBeInTheDocument());
    expect(screen.getByTestId('upgrade-banner').textContent).toContain('Tier 2');
    expect(screen.getByTestId('upgrade-banner').textContent).toContain('$50.00');
  });

  it('dismiss removes the banner (AC 3)', async () => {
    apiGetMock.mockResolvedValue({
      suggestion: {
        id: 's1', tenant_id: TENANT_ID, product_id: PRODUCT_ID,
        suggested_tier_index: 1, projected_savings_cents: 5000,
      },
    });
    apiPostMock.mockResolvedValueOnce({ dismissed: true, cooldown_until: '2027-01-01' });
    render(<UpgradeBanner tenantId={TENANT_ID} productId={PRODUCT_ID} />);
    await waitFor(() => screen.getByTestId('upgrade-dismiss'));
    fireEvent.click(screen.getByTestId('upgrade-dismiss'));
    await waitFor(() => expect(apiPostMock).toHaveBeenCalledWith(
      `/api/v1/tenants/${TENANT_ID}/products/${PRODUCT_ID}/upgrade-suggestion/dismiss`,
      {},
    ));
  });

  it('shows "higher limits" copy when projected_savings=0 (AC 7)', async () => {
    apiGetMock.mockResolvedValue({
      suggestion: {
        id: 's1', tenant_id: TENANT_ID, product_id: PRODUCT_ID,
        suggested_tier_index: 0, projected_savings_cents: 0,
      },
    });
    render(<UpgradeBanner tenantId={TENANT_ID} productId={PRODUCT_ID} />);
    await waitFor(() => screen.getByTestId('upgrade-banner'));
    expect(screen.getByTestId('upgrade-banner').textContent).toContain('higher limits');
  });
});

// ── HUB-1756 (S7): GrandfatherEditor + validateGrandfather ────────────────
describe('HUB-1756 (S7): GrandfatherEditor', () => {
  const PRODUCTS = [{ id: 'p1', name: 'Synapz' }, { id: 'p2', name: 'ContentHelm' }];

  it('shows empty state when no grandfathers', async () => {
    apiGetMock.mockResolvedValue({ data: [], total: 0 });
    render(<GrandfatherEditor tenantId={TENANT_ID} productOptions={PRODUCTS} />);
    await waitFor(() => expect(screen.getByTestId('grandfather-empty')).toBeInTheDocument());
  });

  it('renders existing grandfather rows', async () => {
    apiGetMock.mockResolvedValue({
      data: [{
        id: 'gf1', tenant_id: TENANT_ID, product_id: 'p1',
        policy_type: '12_month_lock', delta_cents: -50000,
        effective_from: '2026-01-01', expires_at: '2027-01-01',
        terms: 'Locked pricing for one year post-migration to Synapz.',
      }],
    });
    render(<GrandfatherEditor tenantId={TENANT_ID} productOptions={PRODUCTS} />);
    await waitFor(() => expect(screen.getByTestId('grandfather-row-gf1')).toBeInTheDocument());
    expect(screen.getByTestId('grandfather-row-gf1').textContent).toContain('12_month_lock');
  });

  it('opens modal + submits valid draft (AC 2)', async () => {
    apiGetMock.mockResolvedValue({ data: [], total: 0 });
    render(<GrandfatherEditor tenantId={TENANT_ID} productOptions={PRODUCTS} />);
    await waitFor(() => screen.getByTestId('grandfather-new-button'));
    fireEvent.click(screen.getByTestId('grandfather-new-button'));
    expect(screen.getByTestId('grandfather-modal')).toBeInTheDocument();
    expect(screen.getByTestId('grandfather-submit')).toBeDisabled();
    // Fill valid draft.
    fireEvent.change(screen.getByTestId('grandfather-product'), { target: { value: 'p1' } });
    fireEvent.change(screen.getByTestId('grandfather-delta'), { target: { value: '-5000' } });
    fireEvent.change(screen.getByTestId('grandfather-effective-from'), { target: { value: '2026-06-01' } });
    fireEvent.change(screen.getByTestId('grandfather-expires-at'), { target: { value: '2027-06-01' } });
    fireEvent.change(screen.getByTestId('grandfather-terms'), {
      target: { value: 'Locked pricing per contract negotiated in Q4 2025.' },
    });
    apiPostMock.mockResolvedValueOnce({});
    fireEvent.click(screen.getByTestId('grandfather-submit'));
    await waitFor(() => expect(apiPostMock).toHaveBeenCalledWith(
      `/api/v1/admin/tenants/${TENANT_ID}/grandfathers`,
      expect.objectContaining({
        product_id: 'p1',
        policy_type: 'custom',
        delta_cents: -5000,
        effective_from: '2026-06-01',
        expires_at: '2027-06-01',
      }),
    ));
  });
});

describe('validateGrandfather', () => {
  const valid = {
    product_id: 'p1',
    policy_type: 'custom' as const,
    delta_cents: '-500',
    effective_from: '2026-01-01',
    expires_at: '2027-01-01',
    terms: 'Some terms text that exceeds twenty characters for compliance.',
  };
  it('accepts a valid draft', () => expect(validateGrandfather(valid)).toEqual({}));
  it('rejects delta = 0', () => {
    expect(validateGrandfather({ ...valid, delta_cents: '0' })).toHaveProperty('delta_cents');
  });
  it('rejects expires <= effective', () => {
    expect(validateGrandfather({ ...valid, expires_at: '2026-01-01' })).toHaveProperty('expires_at');
  });
  it('rejects terms < 20 chars', () => {
    expect(validateGrandfather({ ...valid, terms: 'short' })).toHaveProperty('terms');
  });
});

// ── HUB-1757 (S8): RenewalPreview ─────────────────────────────────────────
describe('HUB-1757 (S8): RenewalPreview', () => {
  it('shows only base price when no grandfather (AC 3)', () => {
    render(
      <RenewalPreview
        productName="Synapz"
        data={{
          base_price_cents: 99900, grandfather_delta_cents: 0,
          effective_price_cents: 99900, applied_grandfather_id: null,
        }}
      />,
    );
    expect(screen.getByText('$999.00')).toBeInTheDocument();
    expect(screen.queryByTestId('renewal-preview-effective')).toBeNull();
  });

  it('shows grandfathered price + savings delta (AC 5)', () => {
    render(
      <RenewalPreview
        productName="Synapz"
        data={{
          base_price_cents: 99900, grandfather_delta_cents: -25000,
          effective_price_cents: 74900, applied_grandfather_id: 'gf1',
        }}
      />,
    );
    expect(screen.getByTestId('renewal-preview-effective').textContent).toContain('$749.00');
    expect(screen.getByTestId('renewal-preview-delta').textContent).toContain('$250.00');
  });

  it('shows surcharge copy when delta is positive', () => {
    render(
      <RenewalPreview
        productName="Synapz"
        data={{
          base_price_cents: 99900, grandfather_delta_cents: 10000,
          effective_price_cents: 109900, applied_grandfather_id: 'gf1',
        }}
      />,
    );
    expect(screen.getByTestId('renewal-preview-delta').textContent).toContain('$100.00');
    // Check container text contains the surcharge word (aria pattern)
    expect(screen.getByText(/surcharge/i)).toBeInTheDocument();
  });
});
