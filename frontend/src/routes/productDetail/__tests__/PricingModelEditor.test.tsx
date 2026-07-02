// Authorized by HUB-1654 (E-FE-5 S4) — PricingModelEditor tests. Covers
// scope-denied path, initial load from BE, draft persistence in
// localStorage, client-side tier + margin-floor validation, save success
// path, save server-error, discard-changes clears draft, dismissible
// active-subscribers banner, and axe-core.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { axe } from 'vitest-axe';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import PricingModelEditor from '../PricingModelEditor';

const apiGetMock = vi.fn();
const apiPutMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
    put: (...args: unknown[]) => apiPutMock(...args),
  },
}));

const PRODUCT = {
  productId: 'prod-1',
  productName: 'Synapz',
  tenantId: 'tenant-1',
};

const MODEL = {
  model_id: 'model-1',
  product_id: 'prod-1',
  model_type: 'tiered',
  currency: 'usd',
  config: { margin_floor_cents: 500 },
  tiers: [
    {
      tier_order: 0,
      up_to_units: 100,
      unit_price_cents: 1000,
      flat_fee_cents: 0,
    },
    {
      tier_order: 1,
      up_to_units: null,
      unit_price_cents: 900,
      flat_fee_cents: 0,
    },
  ],
};

function mockHappy() {
  apiGetMock.mockImplementation((path: string) => {
    if (path.startsWith('/api/v1/admin/portfolio/products')) {
      return Promise.resolve({ data: [PRODUCT] });
    }
    if (path.startsWith('/api/v1/admin/tenants/')) {
      return Promise.resolve(MODEL);
    }
    return Promise.reject(new Error(`unexpected: ${path}`));
  });
}

function renderEditor() {
  return render(
    <MemoryRouter initialEntries={['/console/products/prod-1/pricing']}>
      <Routes>
        <Route
          path="/console/products/:productId/pricing"
          element={<PricingModelEditor />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiGetMock.mockReset();
  apiPutMock.mockReset();
  try {
    localStorage.clear();
  } catch {
    // ignore
  }
});

afterEach(() => {
  cleanup();
});

describe('PricingModelEditor (HUB-1654)', () => {
  describe('AC#1 — initial load + seed from BE model', () => {
    it('renders the editor with model type + currency + margin floor + tiers seeded from the BE payload', async () => {
      mockHappy();
      await act(async () => {
        renderEditor();
      });
      await waitFor(() => {
        expect(screen.getByTestId('pricing-editor-page')).toBeInTheDocument();
      });
      expect(
        (screen.getByTestId('pricing-editor-model-type') as HTMLInputElement).value,
      ).toBe('tiered');
      expect(
        (screen.getByTestId('pricing-editor-currency') as HTMLInputElement).value,
      ).toBe('usd');
      expect(
        (screen.getByTestId('pricing-editor-margin-floor') as HTMLInputElement).value,
      ).toBe('500');
      // Two tier rows rendered.
      expect(screen.getByTestId('pricing-editor-tier-row-0')).toBeInTheDocument();
      expect(screen.getByTestId('pricing-editor-tier-row-1')).toBeInTheDocument();
    });

    it('renders AccessDeniedPage when the operator is out of scope for the product', async () => {
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/portfolio/products')) {
          return Promise.resolve({ data: [] });
        }
        return Promise.reject(new Error('unexpected'));
      });
      await act(async () => {
        renderEditor();
      });
      await waitFor(() => {
        expect(screen.getByTestId('access-denied-page')).toBeInTheDocument();
      });
    });

    it('handles 404 pricing model (product has no model yet) — editor renders with defaults', async () => {
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/portfolio/products')) {
          return Promise.resolve({ data: [PRODUCT] });
        }
        return Promise.reject(new Error('404 not found'));
      });
      await act(async () => {
        renderEditor();
      });
      await waitFor(() => {
        expect(screen.getByTestId('pricing-editor-page')).toBeInTheDocument();
      });
      expect(
        (screen.getByTestId('pricing-editor-model-type') as HTMLInputElement).value,
      ).toBe('flat');
      expect(
        screen.getByTestId('pricing-editor-tiers-empty'),
      ).toBeInTheDocument();
    });
  });

  describe('AC#2 — client-side validation', () => {
    it('rejects tier upper bounds that are not strictly increasing', async () => {
      mockHappy();
      await act(async () => {
        renderEditor();
      });
      await waitFor(() => {
        expect(screen.getByTestId('pricing-editor-tier-row-0')).toBeInTheDocument();
      });
      // Break the tier ordering: set row-1's up_to_units to 50 (below row-0's 100).
      fireEvent.change(screen.getByTestId('pricing-editor-tier-up-to-1'), {
        target: { value: '50' },
      });
      fireEvent.click(screen.getByTestId('pricing-editor-save'));
      expect(
        screen.getByTestId('pricing-editor-tier-up-to-err-1'),
      ).toBeInTheDocument();
      // PUT should not have fired.
      expect(apiPutMock).not.toHaveBeenCalled();
    });

    it('rejects tier unit_price below the margin floor', async () => {
      mockHappy();
      await act(async () => {
        renderEditor();
      });
      await waitFor(() => {
        expect(screen.getByTestId('pricing-editor-tier-row-0')).toBeInTheDocument();
      });
      fireEvent.change(screen.getByTestId('pricing-editor-tier-unit-0'), {
        target: { value: '100' },
      });
      fireEvent.click(screen.getByTestId('pricing-editor-save'));
      expect(
        screen.getByTestId('pricing-editor-tier-unit-err-0'),
      ).toBeInTheDocument();
      expect(apiPutMock).not.toHaveBeenCalled();
    });

    it('rejects malformed JSON in the config textarea', async () => {
      mockHappy();
      await act(async () => {
        renderEditor();
      });
      await waitFor(() => {
        expect(screen.getByTestId('pricing-editor-page')).toBeInTheDocument();
      });
      fireEvent.change(screen.getByTestId('pricing-editor-config-json'), {
        target: { value: '{not valid json' },
      });
      fireEvent.click(screen.getByTestId('pricing-editor-save'));
      expect(
        screen.getByTestId('pricing-editor-config-err'),
      ).toBeInTheDocument();
      expect(apiPutMock).not.toHaveBeenCalled();
    });
  });

  describe('AC#3 — save success + PUT payload shape', () => {
    it('PUTs to the tenant-scoped pricing endpoint and shows success toast', async () => {
      mockHappy();
      apiPutMock.mockResolvedValueOnce({});
      await act(async () => {
        renderEditor();
      });
      await waitFor(() => {
        expect(screen.getByTestId('pricing-editor-tier-row-0')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('pricing-editor-save'));
        await Promise.resolve();
        await Promise.resolve();
      });
      const call = apiPutMock.mock.calls[0]!;
      expect(call[0]).toBe(
        '/api/v1/admin/tenants/tenant-1/products/prod-1/pricing',
      );
      expect(call[1]).toMatchObject({
        modelType: 'tiered',
        currency: 'usd',
      });
      expect(
        screen.getByTestId('pricing-editor-save-success'),
      ).toBeInTheDocument();
    });

    it('surfaces a server-error banner when the PUT rejects', async () => {
      mockHappy();
      apiPutMock.mockRejectedValueOnce(new Error('server exploded'));
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await act(async () => {
        renderEditor();
      });
      await waitFor(() => {
        expect(screen.getByTestId('pricing-editor-tier-row-0')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('pricing-editor-save'));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(
        screen.getByTestId('pricing-editor-save-error').textContent,
      ).toMatch(/server exploded/);
      errSpy.mockRestore();
    });
  });

  describe('AC#4 — draft persistence + discard', () => {
    it('persists edits to localStorage keyed by productId', async () => {
      mockHappy();
      await act(async () => {
        renderEditor();
      });
      await waitFor(() => {
        expect(screen.getByTestId('pricing-editor-page')).toBeInTheDocument();
      });
      fireEvent.change(screen.getByTestId('pricing-editor-model-type'), {
        target: { value: 'graduated' },
      });
      const saved = localStorage.getItem('pricingModelEditor.draft.prod-1');
      expect(saved).toBeTruthy();
      expect(saved!).toMatch(/graduated/);
    });

    it('discard reseeds the on-screen form from the last-loaded BE model', async () => {
      mockHappy();
      await act(async () => {
        renderEditor();
      });
      await waitFor(() => {
        expect(screen.getByTestId('pricing-editor-page')).toBeInTheDocument();
      });
      fireEvent.change(screen.getByTestId('pricing-editor-model-type'), {
        target: { value: 'graduated' },
      });
      // Discard: form snaps back to the server-seeded values.
      fireEvent.click(screen.getByTestId('pricing-editor-discard'));
      expect(
        (screen.getByTestId('pricing-editor-model-type') as HTMLInputElement).value,
      ).toBe('tiered');
      // The persistence effect keeps the reseeded values in sync with
      // localStorage so a subsequent reload picks up the reset state
      // (not the pre-discard edits).
      const saved = localStorage.getItem('pricingModelEditor.draft.prod-1');
      expect(saved).toBeTruthy();
      expect(saved!).not.toMatch(/graduated/);
      expect(saved!).toMatch(/tiered/);
    });
  });

  describe('AC#5 — active-subscribers banner is dismissible', () => {
    it('renders the banner on mount + hides after dismiss', async () => {
      mockHappy();
      await act(async () => {
        renderEditor();
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('pricing-editor-subscribers-banner'),
        ).toBeInTheDocument();
      });
      fireEvent.click(
        screen.getByTestId('pricing-editor-subscribers-banner-dismiss'),
      );
      expect(
        screen.queryByTestId('pricing-editor-subscribers-banner'),
      ).toBeNull();
    });
  });

  describe('a11y — axe-core zero violations', () => {
    it('passes axe scan in the ready state', async () => {
      mockHappy();
      const { container } = renderEditor();
      await waitFor(() => {
        expect(screen.getByTestId('pricing-editor-page')).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});
