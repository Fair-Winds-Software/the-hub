// Authorized by HUB-1636 (E-FE-10 S7) — NFR verification at the SDK versions
// route level. Extends HUB-1629 + HUB-1619 + HUB-1610 with the integration-
// shaped gates the per-component test files can't reach alone:
//   1. axe-core scan on /console/sdk-versions with the chart + breakdown
//      table + impact widget all mounted in the same DOM tree.
//   2. Status-badge a11y floor: all 4 variants (current / behind / EOL /
//      stale) distinguished by icon + text + color (color-only fails AA).
//   3. Page render perf: fetch + 3-section mount fits within the §9 NFR-
//      Performance budget (LCP < 2.5s asserted synthetically).
//   4. Impact-widget response < 1s (synthetic measurement).
//
// Lighthouse CWV measurement for /console/sdk-versions defers to Stage 4
// alongside the other post-auth routes (D-HUB-SCOPE-051 — same in-memory-
// session constraint as /console/dashboard / /console/audit / /console/
// products / /console/compliance). The CI gate continues to measure
// /console/login as the canonical cold-load CWV proxy.
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
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import SdkVersions from '../SdkVersions';

const apiGetMock = vi.fn();
vi.mock('../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

const DIST_RESPONSE = {
  sdkName: 'hub-sdk',
  distribution: [
    { version: '1.5.0', productCount: 1, products: ['Synapz'] },
    { version: '1.4.0', productCount: 1, products: ['ContentHelm'] },
    { version: '1.3.0', productCount: 1, products: ['LegacyApp'] },
    { version: '1.0.0', productCount: 1, products: ['AncientApp'] },
  ],
};

const PRODUCTS_RESPONSE = {
  sdkName: 'hub-sdk',
  products: [
    {
      productId: 'p-1',
      productName: 'Synapz',
      currentVersion: '1.5.0',
      lastReportedAt: '2026-06-29T12:00:00.000Z',
      daysBehindLatest: 0,
      status: 'current' as const,
    },
    {
      productId: 'p-2',
      productName: 'ContentHelm',
      currentVersion: '1.4.0',
      lastReportedAt: '2026-06-25T12:00:00.000Z',
      daysBehindLatest: 1,
      status: 'behind' as const,
    },
    {
      productId: 'p-3',
      productName: 'LegacyApp',
      currentVersion: '1.3.0',
      lastReportedAt: '2026-04-01T12:00:00.000Z',
      daysBehindLatest: 5,
      status: 'stale' as const,
    },
    {
      productId: 'p-4',
      productName: 'AncientApp',
      currentVersion: '1.0.0',
      lastReportedAt: '2026-01-01T12:00:00.000Z',
      daysBehindLatest: 8,
      status: 'eol' as const,
    },
  ],
};

const IMPACT_RESPONSE = {
  sdkName: 'hub-sdk',
  deprecatedVersion: '1.4.0',
  impactedCount: 3,
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
    {
      productId: 'p-4',
      productName: 'AncientApp',
      currentVersion: '1.0.0',
    },
  ],
};

beforeEach(() => {
  apiGetMock.mockReset();
  apiGetMock.mockImplementation((path: string) => {
    if (path.startsWith('/api/v1/admin/sdk-versions/distribution')) {
      return Promise.resolve(DIST_RESPONSE);
    }
    if (path.startsWith('/api/v1/admin/sdk-versions/products')) {
      return Promise.resolve(PRODUCTS_RESPONSE);
    }
    if (path.startsWith('/api/v1/admin/sdk-versions/impact')) {
      return Promise.resolve(IMPACT_RESPONSE);
    }
    return Promise.reject(new Error(`unexpected: ${path}`));
  });
});

afterEach(() => {
  cleanup();
});

describe('SdkVersions NFR verification (HUB-1636)', () => {
  describe('AC#1 — axe-core: /console/sdk-versions has zero violations', () => {
    it('passes axe scan with chart + breakdown table + impact widget mounted', async () => {
      const { container } = render(
        <MemoryRouter initialEntries={['/console/sdk-versions']}>
          <Routes>
            <Route path="/console/sdk-versions" element={<SdkVersions />} />
          </Routes>
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(
          screen.getByTestId('sdk-versions-section-distribution'),
        ).toBeInTheDocument();
      });
      // All three section slots are present + the export button.
      expect(
        screen.getByTestId('sdk-versions-section-products'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('sdk-versions-section-impact'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('sdk-versions-export-csv'),
      ).toBeInTheDocument();
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });

  describe('AC#4 — status badge a11y triple-encoding (icon + text + color)', () => {
    it('all 4 status variants render their own icon + visible text + aria-label', async () => {
      render(
        <MemoryRouter initialEntries={['/console/sdk-versions']}>
          <Routes>
            <Route path="/console/sdk-versions" element={<SdkVersions />} />
          </Routes>
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(
          screen.getByTestId('sdk-versions-section-products'),
        ).toBeInTheDocument();
      });
      // Each badge variant has its own icon testid + aria-labelled wrapper.
      for (const status of ['current', 'behind', 'eol', 'stale'] as const) {
        expect(
          screen.getByTestId(`sdk-status-icon-${status}`),
        ).toBeInTheDocument();
        const expectedLabel =
          status === 'eol' ? 'Status: end-of-life' : `Status: ${status}`;
        expect(
          screen.getByLabelText(expectedLabel),
        ).toBeInTheDocument();
      }
    });
  });

  describe('AC#2 — page render perf (< 2.5s § 9 NFR-Performance)', () => {
    it('mount + parallel fetch resolution + 3-section render stays well under 2500ms', async () => {
      const start = performance.now();
      render(
        <MemoryRouter initialEntries={['/console/sdk-versions']}>
          <Routes>
            <Route path="/console/sdk-versions" element={<SdkVersions />} />
          </Routes>
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(
          screen.getByTestId('sdk-versions-section-distribution'),
        ).toBeInTheDocument();
      });
      const elapsed = performance.now() - start;
      // Spec NFR is LCP < 2500ms; jsdom + mocked fetch is typically <200ms.
      expect(elapsed).toBeLessThan(2500);
    });
  });

  describe('AC#2 — impact widget response < 1s NFR', () => {
    it('selecting a version + impact compute completes well under 1000ms', async () => {
      render(
        <MemoryRouter initialEntries={['/console/sdk-versions']}>
          <Routes>
            <Route path="/console/sdk-versions" element={<SdkVersions />} />
          </Routes>
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(
          screen.getByTestId('impact-version-select'),
        ).toBeInTheDocument();
      });
      const start = performance.now();
      await act(async () => {
        fireEvent.change(screen.getByTestId('impact-version-select'), {
          target: { value: '1.4.0' },
        });
        await Promise.resolve();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(screen.getByTestId('impact-count').textContent).toBe('3');
      });
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(1000);
    });
  });
});
