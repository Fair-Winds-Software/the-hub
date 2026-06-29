// Authorized by HUB-1627 (E-FE-8 S8) — pure-function tests for the client-side
// fallback composer + filename + JSON download helpers. AC-E4 envelope shape
// asserted explicitly: every spec'd key must be present even when underlying
// data is absent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  composeComplianceExport,
  formatExportFilename,
  triggerJsonDownload,
  type ComplianceExportEnvelope,
} from '../composeComplianceExport';
import type { ComplianceDetail } from '../../ComplianceDetail';

function detail(over: Partial<ComplianceDetail> = {}): ComplianceDetail {
  return {
    productId: 'p-1',
    productName: 'Synapz',
    score: 92,
    score_30d_ago: 90,
    last_evaluated_at: '2026-06-25T12:00:00.000Z',
    history: [],
    drift_signals: [],
    controls: [],
    ...over,
  };
}

describe('composeComplianceExport (HUB-1627 AC-E4)', () => {
  it('envelope carries every required key even when child arrays are empty', () => {
    const env = composeComplianceExport(detail(), {
      now: new Date('2026-06-29T00:00:00.000Z'),
      exportedBy: 'sammy@maverick.example',
    });
    const requiredKeys: Array<keyof ComplianceExportEnvelope> = [
      'productId',
      'productName',
      'currentPosture',
      'verdict',
      'lastEvaluated',
      'controls',
      'history',
      'driftSignals',
      'exportedAt',
      'exportedBy',
    ];
    for (const key of requiredKeys) {
      expect(env).toHaveProperty(key);
    }
  });

  it('verdict reflects the score band (>=85 healthy / 60-84 warning / <60 error)', () => {
    expect(composeComplianceExport(detail({ score: 92 })).verdict).toBe('healthy');
    expect(composeComplianceExport(detail({ score: 70 })).verdict).toBe('warning');
    expect(composeComplianceExport(detail({ score: 55 })).verdict).toBe('error');
  });

  it('child arrays default to [] when the detail did not supply them', () => {
    const env = composeComplianceExport({
      productId: 'p-2',
      productName: 'NoHistory',
      score: 80,
      last_evaluated_at: null,
    } as ComplianceDetail);
    expect(env.controls).toEqual([]);
    expect(env.history).toEqual([]);
    expect(env.driftSignals).toEqual([]);
  });

  it('exportedAt is a valid ISO timestamp', () => {
    const env = composeComplianceExport(detail());
    expect(() => new Date(env.exportedAt).toISOString()).not.toThrow();
  });

  it('exportedBy falls back to "(unknown)" when no operator is supplied', () => {
    expect(composeComplianceExport(detail()).exportedBy).toBe('(unknown)');
    expect(
      composeComplianceExport(detail(), { exportedBy: null }).exportedBy,
    ).toBe('(unknown)');
  });

  it('JSON-stringifies cleanly (AC-E4: JSON.parse(JSON.stringify(env)) round-trips)', () => {
    const env = composeComplianceExport(detail());
    const roundTripped = JSON.parse(JSON.stringify(env)) as ComplianceExportEnvelope;
    expect(roundTripped.productId).toBe('p-1');
    expect(roundTripped.verdict).toBe('healthy');
  });
});

describe('formatExportFilename (HUB-1627 AC#3)', () => {
  it('produces hub-compliance-<productId>-YYYYMMDD-HHmmss.json', () => {
    const name = formatExportFilename('p-1', new Date(2026, 5, 25, 12, 30, 0));
    expect(name).toBe('hub-compliance-p-1-20260625-123000.json');
  });

  it('zero-pads single-digit components', () => {
    const name = formatExportFilename('synapz', new Date(2026, 2, 4, 5, 6, 7));
    expect(name).toBe('hub-compliance-synapz-20260304-050607.json');
  });
});

describe('triggerJsonDownload (HUB-1627)', () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let originalClick: typeof HTMLAnchorElement.prototype.click;
  let clickSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createObjectURL = vi.fn(() => 'blob:mock');
    revokeObjectURL = vi.fn();
    (URL as unknown as { createObjectURL: typeof createObjectURL }).createObjectURL =
      createObjectURL;
    (URL as unknown as { revokeObjectURL: typeof revokeObjectURL }).revokeObjectURL =
      revokeObjectURL;
    originalClick = HTMLAnchorElement.prototype.click;
    clickSpy = vi.fn();
    HTMLAnchorElement.prototype.click = clickSpy as unknown as () => void;
  });

  afterEach(() => {
    HTMLAnchorElement.prototype.click = originalClick;
  });

  it('creates a Blob URL, clicks the anchor with the download attr, revokes', () => {
    const env = composeComplianceExport(detail());
    triggerJsonDownload({ filename: 'test.json', envelope: env });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock');
  });

  it('builds the Blob with application/json mime type', () => {
    triggerJsonDownload({
      filename: 'test.json',
      envelope: composeComplianceExport(detail()),
    });
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe('application/json;charset=utf-8');
  });
});
