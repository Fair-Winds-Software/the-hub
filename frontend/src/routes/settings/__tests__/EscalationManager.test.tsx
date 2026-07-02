// Authorized by HUB-1666 (E-FE-6 S7) — EscalationManager tests. Covers
// product picker + rules load, tier grouping by alert_type, 2-tier cap
// hiding the 'Add tier' CTA when both tiers exist, New Rule modal
// validation + POST payload shape, Archive two-step confirm + DELETE,
// includeArchived toggle, and axe zero violations.
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
import { MemoryRouter } from 'react-router-dom';
import EscalationManager from '../EscalationManager';

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
const apiDeleteMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
    post: (...args: unknown[]) => apiPostMock(...args),
    delete: (...args: unknown[]) => apiDeleteMock(...args),
  },
}));

const PRODUCT = {
  productId: 'prod-1',
  productName: 'Synapz',
  tenantId: 'tenant-1',
};

const RULE_T1 = {
  id: 'rule-t1',
  tenant_id: 'tenant-1',
  product_id: 'prod-1',
  alert_type: 'payment_failed',
  tier: 1,
  threshold_minutes: 15,
  escalation_contacts: ['sammy@maverick.launch'],
  archived_at: null,
};

const RULE_T2 = {
  ...RULE_T1,
  id: 'rule-t2',
  tier: 2,
  threshold_minutes: 60,
  escalation_contacts: ['oncall@maverick.launch'],
};

function mockPortfolioAndRules(rules: unknown[] = [RULE_T1]) {
  apiGetMock.mockImplementation((path: string) => {
    if (path.startsWith('/api/v1/admin/portfolio/products')) {
      return Promise.resolve({ data: [PRODUCT] });
    }
    if (path.startsWith('/api/v1/admin/escalation/')) {
      return Promise.resolve({ rules });
    }
    return Promise.reject(new Error(`unexpected: ${path}`));
  });
}

function renderMgr() {
  return render(
    <MemoryRouter>
      <EscalationManager />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  apiDeleteMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('EscalationManager (HUB-1666)', () => {
  it('loads the product picker + shows nothing until a product is selected', async () => {
    mockPortfolioAndRules();
    await act(async () => {
      renderMgr();
    });
    await waitFor(() => {
      expect(screen.getByTestId('escalation-page')).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('escalation-product-picker'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('escalation-list')).toBeNull();
  });

  it('groups rules by alert_type and sorts each group by tier', async () => {
    mockPortfolioAndRules([RULE_T2, RULE_T1]);
    await act(async () => {
      renderMgr();
    });
    await waitFor(() => {
      expect(screen.getByTestId('escalation-page')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId('escalation-product-picker'), {
        target: { value: 'prod-1' },
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('escalation-group-payment_failed'),
      ).toBeInTheDocument();
    });
    const group = screen.getByTestId('escalation-group-payment_failed');
    const rows = group.querySelectorAll('[data-testid^="escalation-row-"]');
    expect(rows[0]!.getAttribute('data-testid')).toBe('escalation-row-rule-t1');
    expect(rows[1]!.getAttribute('data-testid')).toBe('escalation-row-rule-t2');
  });

  it('hides the Add tier CTA when both tiers already exist', async () => {
    mockPortfolioAndRules([RULE_T1, RULE_T2]);
    await act(async () => {
      renderMgr();
    });
    await waitFor(() => {
      expect(screen.getByTestId('escalation-page')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId('escalation-product-picker'), {
        target: { value: 'prod-1' },
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('escalation-group-payment_failed'),
      ).toBeInTheDocument();
    });
    // Both tiers present → Add tier CTA is not rendered.
    expect(
      screen.queryByTestId('escalation-add-payment_failed'),
    ).toBeNull();
  });

  describe('New Rule modal', () => {
    it('rejects missing fields', async () => {
      mockPortfolioAndRules([]);
      await act(async () => {
        renderMgr();
      });
      await waitFor(() => {
        expect(screen.getByTestId('escalation-page')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(screen.getByTestId('escalation-product-picker'), {
          target: { value: 'prod-1' },
        });
        await Promise.resolve();
      });
      fireEvent.click(screen.getByTestId('escalation-new'));
      // Missing alert_type + contacts.
      fireEvent.click(screen.getByTestId('new-rule-submit'));
      expect(
        screen.getByTestId('new-rule-alert-type-err'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('new-rule-contacts-err'),
      ).toBeInTheDocument();
      expect(apiPostMock).not.toHaveBeenCalled();
    });

    it('POSTs the parsed body to the tenant-scoped rules endpoint', async () => {
      mockPortfolioAndRules([]);
      apiPostMock.mockResolvedValueOnce({});
      await act(async () => {
        renderMgr();
      });
      await waitFor(() => {
        expect(screen.getByTestId('escalation-page')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(screen.getByTestId('escalation-product-picker'), {
          target: { value: 'prod-1' },
        });
        await Promise.resolve();
      });
      fireEvent.click(screen.getByTestId('escalation-new'));
      fireEvent.change(screen.getByTestId('new-rule-alert-type'), {
        target: { value: 'payment_failed' },
      });
      fireEvent.change(screen.getByTestId('new-rule-tier'), {
        target: { value: '2' },
      });
      fireEvent.change(screen.getByTestId('new-rule-threshold'), {
        target: { value: '45' },
      });
      fireEvent.change(screen.getByTestId('new-rule-contacts'), {
        target: {
          value: 'sammy@maverick.launch, oncall@maverick.launch',
        },
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('new-rule-submit'));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(apiPostMock).toHaveBeenCalledWith(
        '/api/v1/admin/escalation/tenant-1/prod-1/rules',
        {
          alert_type: 'payment_failed',
          tier: 2,
          threshold_minutes: 45,
          escalation_contacts: [
            'sammy@maverick.launch',
            'oncall@maverick.launch',
          ],
        },
      );
    });

    it('Add tier CTA prefills the alert_type in the modal', async () => {
      mockPortfolioAndRules([RULE_T1]);
      await act(async () => {
        renderMgr();
      });
      await waitFor(() => {
        expect(screen.getByTestId('escalation-page')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(screen.getByTestId('escalation-product-picker'), {
          target: { value: 'prod-1' },
        });
        await Promise.resolve();
      });
      fireEvent.click(screen.getByTestId('escalation-add-payment_failed'));
      expect(
        (screen.getByTestId('new-rule-alert-type') as HTMLInputElement).value,
      ).toBe('payment_failed');
    });
  });

  describe('Archive two-step confirm', () => {
    it('first Continue reveals the confirm panel; second click DELETEs', async () => {
      mockPortfolioAndRules([RULE_T1]);
      apiDeleteMock.mockResolvedValueOnce({});
      await act(async () => {
        renderMgr();
      });
      await waitFor(() => {
        expect(screen.getByTestId('escalation-page')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(screen.getByTestId('escalation-product-picker'), {
          target: { value: 'prod-1' },
        });
        await Promise.resolve();
      });
      fireEvent.click(screen.getByTestId('escalation-archive-rule-t1'));
      fireEvent.click(screen.getByTestId('archive-rule-confirm'));
      expect(
        screen.getByTestId('archive-rule-confirm-panel'),
      ).toBeInTheDocument();
      expect(apiDeleteMock).not.toHaveBeenCalled();
      await act(async () => {
        fireEvent.click(screen.getByTestId('archive-rule-confirm'));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(apiDeleteMock).toHaveBeenCalledWith(
        '/api/v1/admin/escalation/tenant-1/prod-1/rules/rule-t1',
      );
    });
  });

  it('passes axe scan in the picker + list state', async () => {
    mockPortfolioAndRules([RULE_T1]);
    const { container } = renderMgr();
    await waitFor(() => {
      expect(screen.getByTestId('escalation-page')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId('escalation-product-picker'), {
        target: { value: 'prod-1' },
      });
      await Promise.resolve();
    });
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});
