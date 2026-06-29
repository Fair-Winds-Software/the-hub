// Authorized by HUB-1622 (E-FE-8 S3) — Compliance portfolio grid tests. Covers
// fetch wiring, framework filter dropdown + re-fetch, score-to-verdict mapping,
// drift threshold (default 10 + settings override), drift visual on threshold
// breach, tile click navigation, empty/loading/error/denial states + retry, and
// axe-core a11y.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { axe } from 'vitest-axe';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import Compliance from '../Compliance';
import { PermissionDeniedError } from '../../lib/errors';

const apiGetMock = vi.fn();
vi.mock('../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

const ROWS = [
  {
    productId: 'p-1',
    productName: 'Synapz',
    score: 92,
    score_30d_ago: 90,
    last_evaluated_at: '2026-06-25T12:00:00.000Z',
  },
  {
    productId: 'p-2',
    productName: 'ContentHelm',
    score: 72,
    score_30d_ago: 78,
    last_evaluated_at: '2026-06-25T12:00:00.000Z',
  },
  {
    productId: 'p-3',
    productName: 'LaunchKit',
    score: 55,
    score_30d_ago: 70,
    last_evaluated_at: '2026-06-25T12:00:00.000Z',
  },
];

const PORTFOLIO_RESPONSE = { data: ROWS, total: 3 };
const SETTINGS_RESPONSE = {
  data: { compliance_drift_threshold_pct: 10 },
};

function defaultMock() {
  return (path: string) => {
    if (path.startsWith('/api/v1/admin/compliance/portfolio')) {
      return Promise.resolve(PORTFOLIO_RESPONSE);
    }
    if (path === '/api/v1/admin/settings') {
      return Promise.resolve(SETTINGS_RESPONSE);
    }
    return Promise.reject(new Error(`unexpected: ${path}`));
  };
}

beforeEach(() => {
  apiGetMock.mockReset();
  apiGetMock.mockImplementation(defaultMock());
});

afterEach(() => {
  cleanup();
});

function PathProbe() {
  const loc = useLocation();
  return <span data-testid="path">{loc.pathname}</span>;
}

function renderPage(initialUrl = '/console/compliance') {
  return render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <Routes>
        <Route path="/console/compliance" element={<Compliance />} />
        <Route path="/console/compliance/:productId" element={<PathProbe />} />
        <Route path="/console/dashboard" element={<PathProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Compliance (HUB-1622)', () => {
  describe('AC#2/#3 — portfolio grid renders from compliance endpoint', () => {
    it('fetches /api/v1/admin/compliance/portfolio and renders one tile per row', async () => {
      renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('compliance-grid')).toBeInTheDocument();
      });
      expect(
        screen.getByTestId('compliance-tile-p-1'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('compliance-tile-p-2'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('compliance-tile-p-3'),
      ).toBeInTheDocument();
    });

    it('grid <ul> has role=list per AC#10 a11y', async () => {
      renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('compliance-grid')).toBeInTheDocument();
      });
      expect(screen.getByTestId('compliance-grid')).toHaveAttribute(
        'role',
        'list',
      );
    });
  });

  describe('AC#4 — score-to-verdict mapping (green ≥85 / yellow 60-84 / red <60)', () => {
    it('Synapz (92) renders as success; ContentHelm (72) as warning; LaunchKit (55) as error', async () => {
      renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('compliance-tile-p-1')).toBeInTheDocument();
      });
      // Each tile's MetricTile exposes the verdict via the verdict-text testid.
      const p1 = screen.getByTestId('compliance-tile-p-1');
      expect(p1.querySelector('[data-testid="metric-tile-verdict-success"]')).not.toBeNull();
      const p2 = screen.getByTestId('compliance-tile-p-2');
      expect(p2.querySelector('[data-testid="metric-tile-verdict-warning"]')).not.toBeNull();
      const p3 = screen.getByTestId('compliance-tile-p-3');
      expect(p3.querySelector('[data-testid="metric-tile-verdict-error"]')).not.toBeNull();
    });
  });

  describe('AC#5 — drift visual when score dropped > threshold over 30d', () => {
    it('LaunchKit (55 from 70 = -15) shows the drift breach badge + red ring', async () => {
      renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('drift-breach-p-3')).toBeInTheDocument();
      });
      const tile = screen.getByTestId('compliance-tile-p-3');
      expect(tile.className).toMatch(/ring-/);
      expect(screen.getByTestId('drift-breach-p-3').textContent).toMatch(
        /Drift: -15pt in 30d/,
      );
    });

    it('Synapz (92 from 90 = +2) and ContentHelm (72 from 78 = -6) do NOT cross the threshold', async () => {
      renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('compliance-tile-p-1')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('drift-breach-p-1')).toBeNull();
      expect(screen.queryByTestId('drift-breach-p-2')).toBeNull();
    });

    it('settings override changes the drift threshold (5pt → ContentHelm trips)', async () => {
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/compliance/portfolio')) {
          return Promise.resolve(PORTFOLIO_RESPONSE);
        }
        if (path === '/api/v1/admin/settings') {
          return Promise.resolve({
            data: { compliance_drift_threshold_pct: 5 },
          });
        }
        return Promise.reject(new Error('unexpected'));
      });
      renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('drift-breach-p-2')).toBeInTheDocument();
      });
    });

    it('settings fetch failure falls back to default 10pt threshold (no console.error spam swallowed)', async () => {
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/compliance/portfolio')) {
          return Promise.resolve(PORTFOLIO_RESPONSE);
        }
        if (path === '/api/v1/admin/settings') {
          return Promise.reject(new Error('settings down'));
        }
        return Promise.reject(new Error('unexpected'));
      });
      renderPage();
      await waitFor(() => {
        // LaunchKit (-15) still trips at default threshold of 10pt.
        expect(screen.getByTestId('drift-breach-p-3')).toBeInTheDocument();
      });
      // Synapz + ContentHelm still below 10pt threshold.
      expect(screen.queryByTestId('drift-breach-p-1')).toBeNull();
      expect(screen.queryByTestId('drift-breach-p-2')).toBeNull();
    });
  });

  describe('AC#6 — framework filter dropdown re-fetches', () => {
    it('selecting "SOC 2" appends ?framework=soc2 to the portfolio call', async () => {
      renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('compliance-grid')).toBeInTheDocument();
      });
      apiGetMock.mockClear();
      apiGetMock.mockImplementation(defaultMock());

      const filter = screen.getByTestId('compliance-framework-filter');
      fireEvent.change(filter, { target: { value: 'soc2' } });

      await waitFor(() => {
        const calls = apiGetMock.mock.calls
          .map((c) => c[0] as string)
          .filter((p) => p.startsWith('/api/v1/admin/compliance/portfolio'));
        expect(calls.some((c) => c.includes('framework=soc2'))).toBe(true);
      });
    });

    it('default "All" issues a call WITHOUT the framework param', async () => {
      renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('compliance-grid')).toBeInTheDocument();
      });
      const calls = apiGetMock.mock.calls
        .map((c) => c[0] as string)
        .filter((p) => p.startsWith('/api/v1/admin/compliance/portfolio'));
      // First call (the initial fetch with framework=all) has no query string.
      expect(calls[0]).toBe('/api/v1/admin/compliance/portfolio');
    });
  });

  describe('AC#7 — tile click navigates to drill-in', () => {
    it('clicking the Synapz tile pushes /console/compliance/p-1', async () => {
      renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('compliance-tile-p-1')).toBeInTheDocument();
      });
      // MetricTile within the <li> is the role=button element.
      const tile = screen.getByTestId('compliance-tile-p-1').querySelector('[role="button"]');
      expect(tile).not.toBeNull();
      fireEvent.click(tile!);
      await waitFor(() => {
        expect(screen.getByTestId('path').textContent).toBe(
          '/console/compliance/p-1',
        );
      });
    });
  });

  describe('AC#8 — empty state', () => {
    it('renders "No compliance data yet" + Settings link when portfolio is empty', async () => {
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/compliance/portfolio')) {
          return Promise.resolve({ data: [], total: 0 });
        }
        if (path === '/api/v1/admin/settings') {
          return Promise.resolve(SETTINGS_RESPONSE);
        }
        return Promise.reject(new Error('unexpected'));
      });
      renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('compliance-empty-state')).toBeInTheDocument();
      });
      expect(screen.getByText(/controls evaluated nightly/i)).toBeInTheDocument();
      expect(
        screen.getByRole('link', { name: /configure compliance/i }),
      ).toHaveAttribute('href', '/console/settings');
    });
  });

  describe('AC#9 — loading state', () => {
    it('renders skeleton tiles while the portfolio fetch is in flight', () => {
      apiGetMock.mockImplementation(() => new Promise(() => {}));
      renderPage();
      expect(screen.getByTestId('compliance-grid-loading')).toBeInTheDocument();
      expect(screen.getAllByTestId('metric-tile-skeleton').length).toBe(8);
    });
  });

  describe('AC#10 — error state with Retry', () => {
    it('error banner renders + retry refires the portfolio fetch', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      apiGetMock.mockImplementationOnce((path: string) => {
        if (path.startsWith('/api/v1/admin/compliance/portfolio')) {
          return Promise.reject(new Error('upstream down'));
        }
        return Promise.resolve(SETTINGS_RESPONSE);
      });
      // Subsequent calls succeed.
      apiGetMock.mockImplementation(defaultMock());
      renderPage();
      await waitFor(() => {
        expect(
          screen.getByTestId('compliance-error-banner'),
        ).toBeInTheDocument();
      });
      expect(
        screen.getByTestId('compliance-error-banner').textContent,
      ).toContain('upstream down');

      fireEvent.click(screen.getByRole('button', { name: /retry/i }));
      await waitFor(() => {
        expect(screen.getByTestId('compliance-grid')).toBeInTheDocument();
      });
      errSpy.mockRestore();
    });
  });

  describe('HUB-1628 preview — denial UX on 403', () => {
    it('PermissionDeniedError on portfolio fetch renders <AccessDeniedPage>', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/compliance/portfolio')) {
          return Promise.reject(new PermissionDeniedError(403, 'Forbidden'));
        }
        if (path === '/api/v1/admin/settings') {
          return Promise.resolve(SETTINGS_RESPONSE);
        }
        return Promise.reject(new Error('unexpected'));
      });
      renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('access-denied-page')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('compliance-error-banner')).toBeNull();
      errSpy.mockRestore();
    });
  });

  describe('document.title management', () => {
    it('sets title to "Compliance | HUB Console" on mount', () => {
      const original = document.title;
      try {
        renderPage();
        expect(document.title).toBe('Compliance | HUB Console');
      } finally {
        document.title = original;
      }
    });

    it('restores previous title on unmount', () => {
      const original = document.title;
      try {
        document.title = 'Before';
        const { unmount } = renderPage();
        expect(document.title).toBe('Compliance | HUB Console');
        unmount();
        expect(document.title).toBe('Before');
      } finally {
        document.title = original;
      }
    });
  });

  describe('a11y — axe-core zero violations', () => {
    it('passes axe scan with the grid loaded', async () => {
      const { container } = renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('compliance-grid')).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});
