// Authorized by HUB-1629 (E-FE-8 S10) — NFR verification at the Compliance
// portfolio + drill-in route level. Extends HUB-1619 + HUB-1610 with the
// integration-shaped gates the per-component test files can't reach alone:
//   1. axe-core scan on /console/compliance with a populated portfolio grid.
//   2. axe-core scan on /console/compliance/:productId with all 3 sections
//      mounted (Verdict History + Drift Signals + Per-Control Breakdown +
//      Export Report button).
//   3. Verdict triple-encoding contract verified on a sampled tile: SR users
//      hear the verdict semantics in the aria-label (color + icon + text).
//   4. Drill-in render perf: synthetic measurement that the fetch +
//      3-section mount fits within the §9 NFR-Performance drill-in budget.
//
// Lighthouse CWV measurement for /console/compliance + /console/compliance/
// :productId is deferred to Stage 4 alongside /console/dashboard +
// /console/audit + /console/products (D-HUB-SCOPE-051 — post-auth routes
// inside the Zustand in-memory session store can't be measured cold by
// Lighthouse CI's separate JS context). The CI gate continues to measure
// /console/login as the canonical cold-load CWV proxy.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { axe } from 'vitest-axe';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import Compliance from '../Compliance';
import ComplianceDetail from '../ComplianceDetail';

const apiGetMock = vi.fn();
vi.mock('../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

const PORTFOLIO = {
  data: [
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
      score_30d_ago: 75,
      last_evaluated_at: '2026-06-25T12:00:00.000Z',
    },
    {
      productId: 'p-3',
      productName: 'LaunchKit',
      score: 55,
      score_30d_ago: 70,
      last_evaluated_at: '2026-06-25T12:00:00.000Z',
    },
  ],
  total: 3,
};

const SETTINGS = {
  data: { compliance_drift_threshold_pct: 10 },
};

const DRILL_IN = {
  productId: 'p-1',
  productName: 'Synapz',
  score: 92,
  score_30d_ago: 90,
  last_evaluated_at: '2026-06-25T12:00:00.000Z',
  history: [
    { date: '2026-04-01', score: 88 },
    { date: '2026-05-01', score: 85 },
    { date: '2026-06-01', score: 92 },
  ],
  drift_signals: [
    {
      control_id: 'CC6.1',
      control_name: 'Logical access controls',
      status_from: 'passing',
      status_to: 'warning',
      changed_at: '2026-06-20T12:00:00.000Z',
    },
  ],
  controls: [
    {
      control_id: 'CC6.1',
      framework: 'SOC 2',
      control_name: 'Logical access controls',
      status: 'warning',
      last_evaluated_at: '2026-06-25T12:00:00.000Z',
      evidence_url: 'https://evidence.example.com/cc6.1',
    },
  ],
};

beforeEach(() => {
  apiGetMock.mockReset();
  apiGetMock.mockImplementation((path: string) => {
    if (path.startsWith('/api/v1/admin/compliance/portfolio')) {
      return Promise.resolve(PORTFOLIO);
    }
    if (path === '/api/v1/admin/settings') {
      return Promise.resolve(SETTINGS);
    }
    if (path.startsWith('/api/v1/admin/compliance/p-1')) {
      return Promise.resolve(DRILL_IN);
    }
    return Promise.reject(new Error(`unexpected: ${path}`));
  });
});

afterEach(() => {
  cleanup();
});

describe('Compliance NFR verification (HUB-1629)', () => {
  describe('AC#1 — axe-core: /console/compliance portfolio grid has zero violations', () => {
    it('passes axe scan with 3 tiles loaded', async () => {
      const { container } = render(
        <MemoryRouter initialEntries={['/console/compliance']}>
          <Routes>
            <Route path="/console/compliance" element={<Compliance />} />
          </Routes>
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(screen.getByTestId('compliance-grid')).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });

  describe('AC#1 — axe-core: /console/compliance/:productId drill-in with all sections has zero violations', () => {
    it('passes axe scan with header + 3 sections + export button', async () => {
      const { container } = render(
        <MemoryRouter initialEntries={['/console/compliance/p-1']}>
          <Routes>
            <Route
              path="/console/compliance/:productId"
              element={<ComplianceDetail />}
            />
          </Routes>
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(screen.getByTestId('compliance-detail-name')).toBeInTheDocument();
      });
      // All 3 sections + export button are in the DOM.
      expect(
        screen.getByTestId('compliance-section-verdict-history'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('compliance-section-drift-signals'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('compliance-section-per-control'),
      ).toBeInTheDocument();
      expect(screen.getByTestId('export-report-button')).toBeInTheDocument();
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });

  describe('AC#4 — verdict triple-encoding (color + icon + text)', () => {
    it('portfolio tile carries the verdict semantics in its aria-label', async () => {
      render(
        <MemoryRouter initialEntries={['/console/compliance']}>
          <Routes>
            <Route path="/console/compliance" element={<Compliance />} />
          </Routes>
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(screen.getByTestId('compliance-tile-p-1')).toBeInTheDocument();
      });
      // Synapz (92) → "healthy" semantic announced via aria-label.
      expect(
        screen.getByLabelText('Synapz: 92, healthy'),
      ).toBeInTheDocument();
    });
  });

  describe('AC#2 — drill-in render perf (< 1.5s § 9 NFR-Performance)', () => {
    it('drill-in mounts + fetch resolves well within the 1500ms NFR target', async () => {
      const start = performance.now();
      render(
        <MemoryRouter initialEntries={['/console/compliance/p-1']}>
          <Routes>
            <Route
              path="/console/compliance/:productId"
              element={<ComplianceDetail />}
            />
          </Routes>
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(screen.getByTestId('compliance-detail-name')).toBeInTheDocument();
      });
      const elapsed = performance.now() - start;
      // Synthetic measurement against the 1500ms drill-in budget; jsdom +
      // mocked fetch is typically <100ms — headroom is generous.
      expect(elapsed).toBeLessThan(1500);
    });
  });
});
