// Authorized by HUB-1631 (E-FE-10 S2) — SdkVersions page tests. Covers fetch
// wiring + sdkName query param, filter dropdown + URL sync, 3 placeholder
// section slots, empty / loading / error states + Retry, document.title,
// unknown sdkName from URL surfaces as a fallback option, and axe-core.
//
// Route-level RBAC (product_admin URL-hack → redirect) is owned by HUB-1574
// <RBACRoute> and tested in HUB-1578; not re-exercised here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { axe } from 'vitest-axe';
import {
  MemoryRouter,
  Routes,
  Route,
  useLocation,
} from 'react-router-dom';
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
    { version: '1.5.0', productCount: 8, products: ['Synapz', 'ContentHelm'] },
    { version: '1.4.0', productCount: 3, products: ['LaunchKit'] },
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
    return Promise.reject(new Error(`unexpected: ${path}`));
  });
});

afterEach(() => {
  cleanup();
});

function SearchProbe() {
  const loc = useLocation();
  return <span data-testid="search">{loc.search}</span>;
}

function renderPage(initialUrl = '/console/sdk-versions') {
  return render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <Routes>
        <Route
          path="/console/sdk-versions"
          element={
            <>
              <SdkVersions />
              <SearchProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('SdkVersions (HUB-1631)', () => {
  describe('AC#2 — SDK-name filter dropdown', () => {
    it('renders the spec-named SDK options (hub-sdk / synapz-sdk / launchkit-sdk)', async () => {
      renderPage();
      const filter = screen.getByTestId('sdk-versions-filter') as HTMLSelectElement;
      const values = Array.from(filter.options).map((o) => o.value);
      expect(values).toEqual(
        expect.arrayContaining(['hub-sdk', 'synapz-sdk', 'launchkit-sdk']),
      );
      await waitFor(() => {
        expect(filter.value).toBe('hub-sdk');
      });
    });

    it('changing the dropdown mirrors the selection into ?sdkName=', async () => {
      renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('sdk-versions-filter')).toBeInTheDocument();
      });
      fireEvent.change(screen.getByTestId('sdk-versions-filter'), {
        target: { value: 'synapz-sdk' },
      });
      await waitFor(() => {
        expect(screen.getByTestId('search').textContent).toContain(
          'sdkName=synapz-sdk',
        );
      });
    });

    it('changing the dropdown re-fires the distribution fetch with the new sdkName', async () => {
      renderPage();
      await waitFor(() => {
        expect(
          screen.getByTestId('sdk-versions-section-distribution'),
        ).toBeInTheDocument();
      });
      apiGetMock.mockClear();
      apiGetMock.mockImplementation(() => Promise.resolve(DIST_RESPONSE));
      fireEvent.change(screen.getByTestId('sdk-versions-filter'), {
        target: { value: 'launchkit-sdk' },
      });
      await waitFor(() => {
        const calls = apiGetMock.mock.calls.map((c) => c[0] as string);
        expect(
          calls.some((c) => c.includes('sdkName=launchkit-sdk')),
        ).toBe(true);
      });
    });

    it('URL ?sdkName=<unknown> surfaces it as a selected fallback option (deep-link recoverable)', async () => {
      renderPage('/console/sdk-versions?sdkName=experimental-sdk');
      const filter = screen.getByTestId(
        'sdk-versions-filter',
      ) as HTMLSelectElement;
      await waitFor(() => {
        expect(filter.value).toBe('experimental-sdk');
      });
      expect(
        Array.from(filter.options).map((o) => o.value),
      ).toContain('experimental-sdk');
    });
  });

  describe('AC#3 — 3 content slots for S3/S4/S5', () => {
    it('renders Distribution / Product Breakdown / Deprecation Impact section slots', async () => {
      renderPage();
      await waitFor(() => {
        expect(
          screen.getByTestId('sdk-versions-section-distribution'),
        ).toBeInTheDocument();
      });
      expect(
        screen.getByTestId('sdk-versions-section-products'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('sdk-versions-section-impact'),
      ).toBeInTheDocument();
    });

    it('distribution slot renders the real DistributionChart with bars for each version', async () => {
      renderPage();
      // S3 (HUB-1632) now fills the Distribution slot with a real chart;
      // verify the bars from the fetched fixture are mounted.
      await waitFor(() => {
        expect(
          screen.getByTestId('distribution-bar-1.5.0'),
        ).toBeInTheDocument();
      });
      expect(
        screen.getByTestId('distribution-bar-1.4.0'),
      ).toBeInTheDocument();
    });
  });

  describe('AC#5 — loading state', () => {
    it('renders 3 placeholder skeletons while the fetch is in flight', () => {
      apiGetMock.mockImplementation(() => new Promise(() => {}));
      renderPage();
      expect(screen.getByTestId('sdk-versions-loading')).toBeInTheDocument();
    });
  });

  describe('AC#6 — empty state (no SDK reports)', () => {
    it('renders the spec copy + SDK docs link when distribution is empty', async () => {
      apiGetMock.mockImplementation(() =>
        Promise.resolve({ sdkName: 'hub-sdk', distribution: [] }),
      );
      renderPage();
      await waitFor(() => {
        expect(
          screen.getByTestId('sdk-versions-empty-state'),
        ).toBeInTheDocument();
      });
      expect(
        screen.getByText(/phones home on first request/i),
      ).toBeInTheDocument();
      const docsLink = screen.getByTestId('sdk-versions-docs-link');
      expect(docsLink).toHaveAttribute('target', '_blank');
      expect(docsLink).toHaveAttribute('rel', 'noopener noreferrer');
    });
  });

  describe('AC#7 — error state with Retry', () => {
    it('error banner renders + retry refires the fetch', async () => {
      const errSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      // First distribution call rejects; everything else succeeds with the
      // appropriate shape per endpoint.
      let firstDistCall = true;
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/sdk-versions/distribution')) {
          if (firstDistCall) {
            firstDistCall = false;
            return Promise.reject(new Error('upstream down'));
          }
          return Promise.resolve(DIST_RESPONSE);
        }
        if (path.startsWith('/api/v1/admin/sdk-versions/products')) {
          return Promise.resolve(PRODUCTS_RESPONSE);
        }
        return Promise.reject(new Error('unexpected'));
      });
      renderPage();
      await waitFor(() => {
        expect(
          screen.getByTestId('sdk-versions-error-banner'),
        ).toBeInTheDocument();
      });
      expect(
        screen.getByTestId('sdk-versions-error-banner').textContent,
      ).toContain('upstream down');
      fireEvent.click(screen.getByRole('button', { name: /retry/i }));
      await waitFor(() => {
        expect(
          screen.getByTestId('sdk-versions-section-distribution'),
        ).toBeInTheDocument();
      });
      errSpy.mockRestore();
    });
  });

  describe('document.title management', () => {
    it('sets title to "SDK Versions | HUB Console" on mount', () => {
      const original = document.title;
      try {
        renderPage();
        expect(document.title).toBe('SDK Versions | HUB Console');
      } finally {
        document.title = original;
      }
    });

    it('restores the previous title on unmount', () => {
      const original = document.title;
      try {
        document.title = 'Before';
        const { unmount } = renderPage();
        expect(document.title).toBe('SDK Versions | HUB Console');
        unmount();
        expect(document.title).toBe('Before');
      } finally {
        document.title = original;
      }
    });
  });

  describe('a11y — axe-core zero violations', () => {
    it('passes axe scan with the loaded section slots', async () => {
      const { container } = renderPage();
      await waitFor(() => {
        expect(
          screen.getByTestId('sdk-versions-section-distribution'),
        ).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('passes axe scan in the empty state', async () => {
      apiGetMock.mockImplementation(() =>
        Promise.resolve({ sdkName: 'hub-sdk', distribution: [] }),
      );
      const { container } = renderPage();
      await waitFor(() => {
        expect(
          screen.getByTestId('sdk-versions-empty-state'),
        ).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});
