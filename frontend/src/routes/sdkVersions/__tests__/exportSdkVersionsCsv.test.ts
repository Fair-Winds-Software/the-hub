// Authorized by HUB-1635 (E-FE-10 S6) — pure-function tests for the SDK
// versions CSV export. Mirrors the HUB-1617 audit-log CSV pattern: RFC 4180
// escaping, CRLF lines, filename format, empty-set guard, Blob mime type +
// anchor click + URL revoke wiring.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildSdkVersionsCsv,
  exportSdkVersionsCsv,
  formatExportFilename,
} from '../exportSdkVersionsCsv';
import type { ProductBreakdownRow } from '../ProductBreakdownTable';

function row(over: Partial<ProductBreakdownRow> = {}): ProductBreakdownRow {
  return {
    productId: 'p-1',
    productName: 'Synapz',
    currentVersion: '1.5.0',
    lastReportedAt: '2026-06-25T12:00:00.000Z',
    daysBehindLatest: 0,
    status: 'current',
    ...over,
  };
}

describe('buildSdkVersionsCsv (HUB-1635)', () => {
  it('emits a CRLF-terminated header row matching the spec columns', () => {
    const csv = buildSdkVersionsCsv([]);
    expect(csv).toBe(
      'Product,Current SDK Version,Last Reported,Days Behind Latest,Status\r\n',
    );
  });

  it('emits one CRLF-terminated data row per breakdown row', () => {
    const csv = buildSdkVersionsCsv([
      row(),
      row({ productId: 'p-2', productName: 'ContentHelm' }),
    ]);
    const lines = csv.split('\r\n');
    // header + 2 rows + trailing empty string from final CRLF
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain('Synapz');
    expect(lines[2]).toContain('ContentHelm');
    expect(lines[3]).toBe('');
  });

  it('quotes + doubles embedded quotes in product names', () => {
    const csv = buildSdkVersionsCsv([
      row({ productName: 'product "alpha"' }),
    ]);
    expect(csv).toContain('"product ""alpha"""');
  });

  it('quotes fields containing commas (e.g. "ContentHelm, Pro Edition")', () => {
    const csv = buildSdkVersionsCsv([
      row({ productName: 'ContentHelm, Pro Edition' }),
    ]);
    expect(csv).toContain('"ContentHelm, Pro Edition"');
  });

  it('preserves newlines inside quoted fields', () => {
    const csv = buildSdkVersionsCsv([
      row({ productName: 'line1\nline2' }),
    ]);
    expect(csv).toContain('"line1\nline2"');
  });

  it('uses the lastReportedAt ISO string verbatim (no locale formatting)', () => {
    const csv = buildSdkVersionsCsv([row()]);
    expect(csv).toContain('2026-06-25T12:00:00.000Z');
  });

  it('renders daysBehindLatest as a bare integer (no thousands separators)', () => {
    const csv = buildSdkVersionsCsv([row({ daysBehindLatest: 1234 })]);
    const dataLine = csv.split('\r\n')[1]!;
    const cols = dataLine.split(',');
    expect(cols[3]).toBe('1234');
  });
});

describe('formatExportFilename (HUB-1635)', () => {
  it('produces hub-sdk-versions-<sdkName>-YYYYMMDD-HHmmss.csv', () => {
    const name = formatExportFilename(
      'hub-sdk',
      new Date(2026, 5, 25, 12, 30, 0),
    );
    expect(name).toBe('hub-sdk-versions-hub-sdk-20260625-123000.csv');
  });

  it('zero-pads single-digit components', () => {
    const name = formatExportFilename(
      'synapz-sdk',
      new Date(2026, 2, 4, 5, 6, 7),
    );
    expect(name).toBe('hub-sdk-versions-synapz-sdk-20260304-050607.csv');
  });
});

describe('exportSdkVersionsCsv (HUB-1635)', () => {
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:mock');
  const revokeObjectURL = vi.fn();
  let originalClick: typeof HTMLAnchorElement.prototype.click;
  let clickSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
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

  it('throws on empty rows (defense in depth for the disabled-button contract)', () => {
    expect(() => exportSdkVersionsCsv([], 'hub-sdk')).toThrow(/empty/);
  });

  it('creates a Blob URL, clicks the anchor with the download attr, then revokes', () => {
    const filename = exportSdkVersionsCsv([row()], 'hub-sdk', {
      now: new Date(2026, 5, 25, 12, 30, 0),
    });
    expect(filename).toBe('hub-sdk-versions-hub-sdk-20260625-123000.csv');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock');
  });

  it('builds the Blob with text/csv mime type', () => {
    exportSdkVersionsCsv([row()], 'hub-sdk');
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe('text/csv;charset=utf-8');
  });
});
