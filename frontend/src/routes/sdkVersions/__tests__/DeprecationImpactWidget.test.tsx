// Authorized by HUB-1634 (E-FE-10 S5) — DeprecationImpactWidget tests. Covers
// version dropdown population, BE primary path, 404 → client-side fallback
// path, empty-result "safe to deprecate" branch, version-switch caching (no
// duplicate BE calls for the same tuple), SDK-switch reset of selection +
// cache, aria-live announcement on result, and axe-core a11y.
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
import { DeprecationImpactWidget } from '../DeprecationImpactWidget';
import type { ProductBreakdownRow } from '../ProductBreakdownTable';

const apiGetMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

const VERSIONS = ['1.5.0', '1.4.0', '1.3.0'];

const PRODUCTS: ProductBreakdownRow[] = [
  {
    productId: 'p-1',
    productName: 'Synapz',
    currentVersion: '1.5.0',
    lastReportedAt: '2026-06-29T12:00:00.000Z',
    daysBehindLatest: 0,
    status: 'current',
  },
  {
    productId: 'p-2',
    productName: 'ContentHelm',
    currentVersion: '1.4.0',
    lastReportedAt: '2026-06-25T12:00:00.000Z',
    daysBehindLatest: 1,
    status: 'behind',
  },
  {
    productId: 'p-3',
    productName: 'LegacyApp',
    currentVersion: '1.3.0',
    lastReportedAt: '2026-04-01T12:00:00.000Z',
    daysBehindLatest: 8,
    status: 'stale',
  },
];

beforeEach(() => {
  apiGetMock.mockReset();
});

afterEach(() => {
  cleanup();
});

function renderWidget(
  props: Partial<React.ComponentProps<typeof DeprecationImpactWidget>> = {},
) {
  return render(
    <DeprecationImpactWidget
      sdkName="hub-sdk"
      versions={VERSIONS}
      products={PRODUCTS}
      {...props}
    />,
  );
}

describe('DeprecationImpactWidget (HUB-1634)', () => {
  describe('AC#2/#3 — heading + version dropdown', () => {
    it('renders the heading + a version dropdown populated from props', () => {
      renderWidget();
      expect(
        screen.getByRole('heading', { name: 'Deprecation Impact Preview' }),
      ).toBeInTheDocument();
      const select = screen.getByTestId('impact-version-select') as HTMLSelectElement;
      const values = Array.from(select.options).map((o) => o.value);
      // Includes the placeholder + each version from props.
      expect(values).toEqual(['', ...VERSIONS]);
    });

    it('idle by default — no impact display, no aria-live announcement', () => {
      renderWidget();
      expect(screen.queryByTestId('impact-result')).toBeNull();
      expect(screen.queryByTestId('impact-empty')).toBeNull();
      expect(
        screen.getByTestId('impact-live-region').textContent,
      ).toBe('');
    });
  });

  describe('AC#5 — primary path: BE impact endpoint', () => {
    it('selecting a version calls the impact endpoint + renders count + product list', async () => {
      apiGetMock.mockResolvedValue({
        sdkName: 'hub-sdk',
        deprecatedVersion: '1.4.0',
        impactedCount: 2,
        products: [
          {
            productId: 'p-2',
            productName: 'ContentHelm',
            currentVersion: '1.4.0',
          },
          {
            productId: 'p-3',
            productName: 'LegacyApp',
            currentVersion: '1.3.0',
          },
        ],
      });
      renderWidget();
      await act(async () => {
        fireEvent.change(screen.getByTestId('impact-version-select'), {
          target: { value: '1.4.0' },
        });
        await Promise.resolve();
        await Promise.resolve();
      });
      const call = apiGetMock.mock.calls[0]?.[0] as string;
      expect(call).toContain('/api/v1/admin/sdk-versions/impact');
      expect(call).toContain('sdkName=hub-sdk');
      expect(call).toContain('version=1.4.0');
      expect(screen.getByTestId('impact-count').textContent).toBe('2');
      expect(
        screen.getByTestId('impact-product-p-2'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('impact-product-p-3'),
      ).toBeInTheDocument();
    });
  });

  describe('AC#6 — fallback: BE 404 → client-side compute', () => {
    it('404 from impact endpoint falls back to local compute from products data', async () => {
      apiGetMock.mockRejectedValue(new Error('Request failed: 404'));
      renderWidget();
      await act(async () => {
        fireEvent.change(screen.getByTestId('impact-version-select'), {
          target: { value: '1.4.0' },
        });
        await Promise.resolve();
        await Promise.resolve();
      });
      // Client-side compute: ContentHelm (1.4.0) + LegacyApp (1.3.0) impacted.
      expect(screen.getByTestId('impact-count').textContent).toBe('2');
      expect(
        screen.getByTestId('impact-product-p-2'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('impact-product-p-3'),
      ).toBeInTheDocument();
    });

    it('non-404 BE error renders the error alert (no fallback)', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      apiGetMock.mockRejectedValue(new Error('Internal server error'));
      renderWidget();
      await act(async () => {
        fireEvent.change(screen.getByTestId('impact-version-select'), {
          target: { value: '1.4.0' },
        });
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByTestId('impact-error').textContent).toContain(
        'Internal server error',
      );
      errSpy.mockRestore();
    });
  });

  describe('AC#8 — empty-result safe-to-deprecate branch', () => {
    it('zero impact renders "safe to deprecate" with the selected version', async () => {
      apiGetMock.mockResolvedValue({
        sdkName: 'hub-sdk',
        deprecatedVersion: '0.9.0',
        impactedCount: 0,
        products: [],
      });
      renderWidget();
      await act(async () => {
        fireEvent.change(screen.getByTestId('impact-version-select'), {
          target: { value: '1.3.0' },
        });
        await Promise.resolve();
        await Promise.resolve();
      });
      // We selected 1.3.0 but the BE response said 0 impacted. UI uses
      // selected from state, not deprecatedVersion from response.
      const banner = screen.getByTestId('impact-empty');
      expect(banner.textContent).toContain('1.3.0');
      expect(banner.textContent).toMatch(/safe to deprecate/i);
    });
  });

  describe('caching — version-switch cache prevents duplicate BE calls', () => {
    it('switching back to a previously-computed version does NOT refire the BE call', async () => {
      apiGetMock.mockResolvedValue({
        sdkName: 'hub-sdk',
        deprecatedVersion: '1.4.0',
        impactedCount: 2,
        products: [],
      });
      renderWidget();
      // First compute against 1.4.0.
      await act(async () => {
        fireEvent.change(screen.getByTestId('impact-version-select'), {
          target: { value: '1.4.0' },
        });
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(apiGetMock).toHaveBeenCalledTimes(1);

      // Switch to 1.3.0 (new compute) and back to 1.4.0 (cache hit).
      await act(async () => {
        fireEvent.change(screen.getByTestId('impact-version-select'), {
          target: { value: '1.3.0' },
        });
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(apiGetMock).toHaveBeenCalledTimes(2);

      await act(async () => {
        fireEvent.change(screen.getByTestId('impact-version-select'), {
          target: { value: '1.4.0' },
        });
        await Promise.resolve();
        await Promise.resolve();
      });
      // No additional fetch — cache hit.
      expect(apiGetMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('SDK-switch reset', () => {
    it('changing sdkName clears selection + cache (versions no longer apply)', async () => {
      apiGetMock.mockResolvedValue({
        sdkName: 'hub-sdk',
        deprecatedVersion: '1.4.0',
        impactedCount: 2,
        products: [],
      });
      const { rerender } = renderWidget();
      await act(async () => {
        fireEvent.change(screen.getByTestId('impact-version-select'), {
          target: { value: '1.4.0' },
        });
        await Promise.resolve();
        await Promise.resolve();
      });
      apiGetMock.mockClear();

      // Parent switched to a different SDK; widget's effect clears state.
      rerender(
        <DeprecationImpactWidget
          sdkName="synapz-sdk"
          versions={['2.0.0']}
          products={PRODUCTS}
        />,
      );
      const select = screen.getByTestId(
        'impact-version-select',
      ) as HTMLSelectElement;
      expect(select.value).toBe('');
      expect(screen.queryByTestId('impact-result')).toBeNull();
    });
  });

  describe('AC#9 — aria-live announcement', () => {
    it('aria-live region announces the impact count after a successful compute', async () => {
      apiGetMock.mockResolvedValue({
        sdkName: 'hub-sdk',
        deprecatedVersion: '1.4.0',
        impactedCount: 2,
        products: [],
      });
      renderWidget();
      await act(async () => {
        fireEvent.change(screen.getByTestId('impact-version-select'), {
          target: { value: '1.4.0' },
        });
        await Promise.resolve();
        await Promise.resolve();
      });
      const live = screen.getByTestId('impact-live-region');
      expect(live).toHaveAttribute('aria-live', 'polite');
      expect(live.textContent).toMatch(
        /If you deprecate 1\.4\.0, 2 products would break/,
      );
    });
  });

  describe('a11y — axe-core zero violations', () => {
    it('passes axe scan in idle state', async () => {
      const { container } = renderWidget();
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('passes axe scan with an impact result rendered', async () => {
      apiGetMock.mockResolvedValue({
        sdkName: 'hub-sdk',
        deprecatedVersion: '1.4.0',
        impactedCount: 2,
        products: [
          {
            productId: 'p-2',
            productName: 'ContentHelm',
            currentVersion: '1.4.0',
          },
        ],
      });
      const { container } = renderWidget();
      await act(async () => {
        fireEvent.change(screen.getByTestId('impact-version-select'), {
          target: { value: '1.4.0' },
        });
        await Promise.resolve();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(screen.getByTestId('impact-result')).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});
