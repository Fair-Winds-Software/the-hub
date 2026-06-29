// Authorized by HUB-1623 (E-FE-8 S4) — ComplianceDetail scaffold tests. Covers
// loading skeletons, header render (name + score + verdict badge), 3-section
// vertical stack, per-section error boundary isolation, 404 not-found, error
// banner, denial UX, document.title, and axe-core a11y.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { axe } from 'vitest-axe';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ComplianceDetail, { ComplianceSectionErrorBoundary } from '../ComplianceDetail';
import { PermissionDeniedError } from '../../lib/errors';

const apiGetMock = vi.fn();
vi.mock('../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

const PRODUCT = {
  productId: 'p-1',
  productName: 'Synapz',
  score: 92,
  score_30d_ago: 90,
  last_evaluated_at: '2026-06-25T12:00:00.000Z',
};

beforeEach(() => {
  apiGetMock.mockReset();
  apiGetMock.mockImplementation((path: string) => {
    if (path.startsWith('/api/v1/admin/compliance/')) {
      return Promise.resolve(PRODUCT);
    }
    return Promise.reject(new Error(`unexpected: ${path}`));
  });
});

afterEach(() => {
  cleanup();
});

function renderDetail(productId: string) {
  return render(
    <MemoryRouter initialEntries={[`/console/compliance/${productId}`]}>
      <Routes>
        <Route
          path="/console/compliance/:productId"
          element={<ComplianceDetail />}
        />
        <Route path="/console/compliance" element={<div data-testid="list" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ComplianceDetail (HUB-1623)', () => {
  describe('AC#6 — loading state renders header + 3 section skeletons', () => {
    it('renders header + 3 section skeletons while fetch is in flight', () => {
      apiGetMock.mockImplementation(() => new Promise(() => {}));
      renderDetail('p-1');
      expect(
        screen.getByTestId('compliance-detail-header-skeleton'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('compliance-section-skeleton-verdict-history'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('compliance-section-skeleton-drift-signals'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('compliance-section-skeleton-per-control'),
      ).toBeInTheDocument();
    });
  });

  describe('AC#2 — header renders name + score + verdict badge', () => {
    it('renders product name in h1; verdict badge; posture score', async () => {
      renderDetail('p-1');
      await waitFor(() => {
        expect(screen.getByTestId('compliance-detail-name')).toBeInTheDocument();
      });
      expect(
        screen.getByRole('heading', { level: 1, name: 'Synapz' }),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('compliance-detail-verdict-badge').textContent,
      ).toBe('healthy');
      expect(screen.getByTestId('compliance-detail-score').textContent).toBe(
        '92',
      );
    });

    it.each([
      { score: 92, label: 'healthy' },
      { score: 70, label: 'warning' },
      { score: 40, label: 'error' },
    ])('score $score → verdict badge "$label"', async ({ score, label }) => {
      apiGetMock.mockImplementation(() => Promise.resolve({ ...PRODUCT, score }));
      renderDetail('p-1');
      await waitFor(() => {
        expect(
          screen.getByTestId('compliance-detail-verdict-badge').textContent,
        ).toBe(label);
      });
    });
  });

  describe('AC#3 — 3-section vertical stack', () => {
    it('renders Verdict History / Drift Signals / Per-Control Breakdown sections', async () => {
      renderDetail('p-1');
      await waitFor(() => {
        expect(
          screen.getByTestId('compliance-section-verdict-history'),
        ).toBeInTheDocument();
      });
      expect(
        screen.getByTestId('compliance-section-drift-signals'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('compliance-section-per-control'),
      ).toBeInTheDocument();
    });

    it('each section uses <section aria-labelledby> per AC FE-a11y', async () => {
      renderDetail('p-1');
      await waitFor(() => {
        expect(
          screen.getByTestId('compliance-section-verdict-history'),
        ).toBeInTheDocument();
      });
      // Each section component owns its own aria-labelledby id; assert that the
      // attribute is present + the referenced heading exists, without coupling
      // to a single id-naming convention (HUB-1624 Verdict History uses
      // 'history-timeline-heading' for example).
      const sections = ['verdict-history', 'drift-signals', 'per-control'];
      for (const id of sections) {
        const section = screen.getByTestId(`compliance-section-${id}`);
        const labelledBy = section.getAttribute('aria-labelledby');
        expect(labelledBy).toBeTruthy();
        expect(document.getElementById(labelledBy!)).toBeInTheDocument();
      }
    });
  });

  describe('AC#4 — per-section error boundary isolates failures', () => {
    function Boom(): React.ReactElement {
      throw new Error('boom');
    }

    it('boundary catches a throwing child and renders the named fallback', () => {
      const errSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      render(
        <ComplianceSectionErrorBoundary name="verdict-history">
          <Boom />
        </ComplianceSectionErrorBoundary>,
      );
      const fallback = screen.getByTestId(
        'compliance-section-fallback-verdict-history',
      );
      expect(fallback).toBeInTheDocument();
      expect(fallback.textContent).toMatch(
        /Failed to load verdict-history\. Refresh to retry\./,
      );
      errSpy.mockRestore();
    });

    it('boundary renders children unchanged when they do not throw', () => {
      render(
        <ComplianceSectionErrorBoundary name="drift-signals">
          <span data-testid="happy-child">OK</span>
        </ComplianceSectionErrorBoundary>,
      );
      expect(screen.getByTestId('happy-child')).toBeInTheDocument();
      expect(
        screen.queryByTestId('compliance-section-fallback-drift-signals'),
      ).toBeNull();
    });

    it('sibling boundaries are independent — one throw does not poison the other section', () => {
      const errSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      render(
        <div>
          <ComplianceSectionErrorBoundary name="verdict-history">
            <Boom />
          </ComplianceSectionErrorBoundary>
          <ComplianceSectionErrorBoundary name="drift-signals">
            <span data-testid="sibling-ok">still here</span>
          </ComplianceSectionErrorBoundary>
        </div>,
      );
      expect(
        screen.getByTestId('compliance-section-fallback-verdict-history'),
      ).toBeInTheDocument();
      expect(screen.getByTestId('sibling-ok')).toBeInTheDocument();
      errSpy.mockRestore();
    });
  });

  describe('AC#7 — error banner on fetch failure', () => {
    it('full-page error banner with Back to Compliance link', async () => {
      const errSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      apiGetMock.mockImplementation(() =>
        Promise.reject(new Error('upstream timeout')),
      );
      renderDetail('p-1');
      await waitFor(() => {
        expect(
          screen.getByTestId('compliance-detail-error'),
        ).toBeInTheDocument();
      });
      expect(
        screen.getByTestId('compliance-detail-error').textContent,
      ).toContain('upstream timeout');
      expect(
        screen.getByRole('link', { name: /back to compliance/i }),
      ).toHaveAttribute('href', '/console/compliance');
      errSpy.mockRestore();
    });
  });

  describe('AC#8 — 404 not-found', () => {
    it('error containing 404 → "Product not found in compliance system" + back link', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      apiGetMock.mockImplementation(() =>
        Promise.reject(new Error('Request failed: 404')),
      );
      renderDetail('p-does-not-exist');
      await waitFor(() => {
        expect(
          screen.getByTestId('compliance-detail-not-found'),
        ).toBeInTheDocument();
      });
      expect(
        screen.getByRole('link', { name: /back to compliance/i }),
      ).toHaveAttribute('href', '/console/compliance');
      errSpy.mockRestore();
    });

    it('response without productId field also resolves to not-found', async () => {
      apiGetMock.mockImplementation(() => Promise.resolve({}));
      renderDetail('p-1');
      await waitFor(() => {
        expect(
          screen.getByTestId('compliance-detail-not-found'),
        ).toBeInTheDocument();
      });
    });
  });

  describe('HUB-1628 — denial UX on 403 (URL-hack to out-of-scope productId)', () => {
    it('PermissionDeniedError renders <AccessDeniedPage> with back-link to /console/compliance', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      apiGetMock.mockImplementation(() =>
        Promise.reject(new PermissionDeniedError(403, 'Forbidden')),
      );
      renderDetail('p-out-of-scope');
      await waitFor(() => {
        expect(screen.getByTestId('access-denied-page')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('compliance-detail-error')).toBeNull();
      expect(screen.queryByTestId('compliance-detail-not-found')).toBeNull();
      expect(
        screen.getByTestId('access-denied-back-link'),
      ).toHaveAttribute('href', '/console/compliance');
      errSpy.mockRestore();
    });
  });

  describe('AC#9 — document.title management', () => {
    it('sets title to "<Product Name> | Compliance | HUB Console" once loaded', async () => {
      const original = document.title;
      try {
        renderDetail('p-1');
        await waitFor(() => {
          expect(document.title).toBe('Synapz | Compliance | HUB Console');
        });
      } finally {
        document.title = original;
      }
    });

    it('restores the previous title on unmount', async () => {
      const original = document.title;
      try {
        document.title = 'Before';
        const { unmount } = renderDetail('p-1');
        await waitFor(() => {
          expect(document.title).toBe('Synapz | Compliance | HUB Console');
        });
        unmount();
        expect(document.title).toBe('Before');
      } finally {
        document.title = original;
      }
    });
  });

  describe('a11y — axe-core zero violations', () => {
    it('passes axe scan in the loaded-ready state', async () => {
      const { container } = renderDetail('p-1');
      await waitFor(() => {
        expect(screen.getByTestId('compliance-detail-name')).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('passes axe scan in the not-found state', async () => {
      apiGetMock.mockImplementation(() => Promise.resolve({}));
      const { container } = renderDetail('p-1');
      await waitFor(() => {
        expect(
          screen.getByTestId('compliance-detail-not-found'),
        ).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});
