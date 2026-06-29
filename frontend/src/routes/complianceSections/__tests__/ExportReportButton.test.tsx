// Authorized by HUB-1627 (E-FE-8 S8) — ExportReportButton tests. Covers primary
// path (BE export endpoint succeeds → JSON download with BE-supplied envelope),
// fallback path (404 → client-side compose with the in-memory detail), error
// state with Try again affordance, aria-busy during in-flight export, and the
// "Export compliance report as JSON" aria-label.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { ExportReportButton } from '../ExportReportButton';
import type { ComplianceDetail } from '../../ComplianceDetail';

const apiGetMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

vi.mock('../../../stores/sessionStore', () => ({
  useOperator: () => ({
    id: 'op-1',
    email: 'sammy@maverick.example',
    name: 'Sammy',
    role: 'super_admin',
  }),
}));

const DETAIL: ComplianceDetail = {
  productId: 'p-1',
  productName: 'Synapz',
  score: 92,
  score_30d_ago: 90,
  last_evaluated_at: '2026-06-25T12:00:00.000Z',
  history: [{ date: '2026-06-01', score: 90 }],
  drift_signals: [],
  controls: [],
};

let createObjectURL: ReturnType<typeof vi.fn>;
let originalClick: typeof HTMLAnchorElement.prototype.click;
let clickSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  apiGetMock.mockReset();
  createObjectURL = vi.fn(() => 'blob:mock');
  (URL as unknown as { createObjectURL: typeof createObjectURL }).createObjectURL =
    createObjectURL;
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
  originalClick = HTMLAnchorElement.prototype.click;
  clickSpy = vi.fn();
  HTMLAnchorElement.prototype.click = clickSpy as unknown as () => void;
});

afterEach(() => {
  HTMLAnchorElement.prototype.click = originalClick;
  cleanup();
});

describe('ExportReportButton (HUB-1627)', () => {
  describe('AC#1 — button rendering + aria-label', () => {
    it('renders an Export Report button labeled "Export compliance report as JSON"', () => {
      render(<ExportReportButton detail={DETAIL} />);
      const btn = screen.getByTestId('export-report-button');
      expect(btn).toHaveAttribute(
        'aria-label',
        'Export compliance report as JSON',
      );
      expect(btn.textContent).toMatch(/Export Report/);
    });
  });

  describe('AC#4 — primary path: BE export endpoint succeeds', () => {
    it('clicks the button → GETs /api/v1/admin/compliance/p-1/export and downloads the response', async () => {
      const beEnvelope = {
        productId: 'p-1',
        productName: 'Synapz',
        currentPosture: 92,
        verdict: 'healthy',
        lastEvaluated: '2026-06-25T12:00:00.000Z',
        controls: [],
        history: [],
        driftSignals: [],
        exportedAt: '2026-06-29T00:00:00.000Z',
        exportedBy: 'be-system',
      };
      apiGetMock.mockResolvedValue(beEnvelope);
      render(<ExportReportButton detail={DETAIL} />);
      await act(async () => {
        fireEvent.click(screen.getByTestId('export-report-button'));
        await Promise.resolve();
        await Promise.resolve();
      });
      const calls = apiGetMock.mock.calls.map((c) => c[0] as string);
      expect(calls).toContain('/api/v1/admin/compliance/p-1/export');
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(clickSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('AC#5 — fallback: BE endpoint 404 composes from in-memory detail', () => {
    it('404 from the export endpoint still triggers a download', async () => {
      apiGetMock.mockRejectedValue(new Error('Request failed: 404'));
      render(<ExportReportButton detail={DETAIL} />);
      await act(async () => {
        fireEvent.click(screen.getByTestId('export-report-button'));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(clickSpy).toHaveBeenCalledTimes(1);
      // No error rendered — fallback path is a success outcome.
      expect(screen.queryByTestId('export-report-error')).toBeNull();
    });

    it('fallback path was taken (Blob created from the in-memory compose, not from BE response)', async () => {
      apiGetMock.mockRejectedValue(new Error('Request failed: 404'));
      render(<ExportReportButton detail={DETAIL} />);
      await act(async () => {
        fireEvent.click(screen.getByTestId('export-report-button'));
        await Promise.resolve();
        await Promise.resolve();
      });
      // BE call rejected with 404; if the fallback composer didn't run, no
      // Blob would have been created. createObjectURL fired once -> fallback
      // produced an envelope and the download was triggered. (Blob contents
      // are unit-tested directly in composeComplianceExport.test.ts.)
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      const blob = createObjectURL.mock.calls[0][0] as Blob;
      expect(blob.type).toBe('application/json;charset=utf-8');
    });
  });

  describe('AC#8 — error state + Try again affordance', () => {
    it('non-404 BE failure renders the error banner with the message + Try again', async () => {
      apiGetMock.mockRejectedValue(new Error('Internal server error'));
      render(<ExportReportButton detail={DETAIL} />);
      await act(async () => {
        fireEvent.click(screen.getByTestId('export-report-button'));
        await Promise.resolve();
        await Promise.resolve();
      });
      const err = screen.getByTestId('export-report-error');
      expect(err.textContent).toContain('Internal server error');
      expect(err.textContent).toMatch(/try again/i);
    });

    it('Try again button re-fires the export call', async () => {
      apiGetMock.mockRejectedValueOnce(new Error('Internal server error'));
      apiGetMock.mockResolvedValueOnce({
        productId: 'p-1',
        productName: 'Synapz',
        currentPosture: 92,
        verdict: 'healthy',
        lastEvaluated: '2026-06-25T12:00:00.000Z',
        controls: [],
        history: [],
        driftSignals: [],
        exportedAt: '2026-06-29T00:00:00.000Z',
        exportedBy: 'be-system',
      });
      render(<ExportReportButton detail={DETAIL} />);
      await act(async () => {
        fireEvent.click(screen.getByTestId('export-report-button'));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByTestId('export-report-error')).toBeInTheDocument();
      const tryAgain = screen.getByRole('button', { name: /try again/i });
      await act(async () => {
        fireEvent.click(tryAgain);
        await Promise.resolve();
        await Promise.resolve();
      });
      // Second call succeeded → download fires.
      expect(clickSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('AC#7 — loading + aria-busy', () => {
    it('aria-busy=true while the export is in flight; disabled', async () => {
      let resolve: (v: unknown) => void = () => {};
      apiGetMock.mockImplementation(
        () =>
          new Promise((res) => {
            resolve = res;
          }),
      );
      render(<ExportReportButton detail={DETAIL} />);
      const btn = screen.getByTestId('export-report-button');
      await act(async () => {
        fireEvent.click(btn);
        await Promise.resolve();
      });
      expect(btn).toHaveAttribute('aria-busy', 'true');
      expect(btn).toBeDisabled();
      expect(btn.textContent).toMatch(/exporting/i);

      // Let the in-flight call resolve so the test cleans up cleanly.
      await act(async () => {
        resolve({
          productId: 'p-1',
          productName: 'Synapz',
          currentPosture: 92,
          verdict: 'healthy',
          lastEvaluated: '2026-06-25T12:00:00.000Z',
          controls: [],
          history: [],
          driftSignals: [],
          exportedAt: '2026-06-29T00:00:00.000Z',
          exportedBy: 'be-system',
        });
        await Promise.resolve();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(btn).toHaveAttribute('aria-busy', 'false');
      });
    });
  });
});
