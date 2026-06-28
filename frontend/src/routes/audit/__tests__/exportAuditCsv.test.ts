// Authorized by HUB-1617 (E-FE-12 S7) — exportAuditCsv unit tests. Covers RFC 4180
// escaping (comma, quote, newline), Detail JSON assembly, header row, filename
// timestamp formatting, empty-set guard, and Blob download wiring.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuditCsv,
  exportAuditCsv,
  formatExportFilename,
} from '../exportAuditCsv';
import type { AuditRow } from '../AuditFilters';

function row(over: Partial<AuditRow> = {}): AuditRow {
  return {
    id: 'r-1',
    operator_id: 'op-1',
    entity_type: 'products',
    entity_id: 'p-1',
    action: 'INSERT',
    before_value: null,
    after_value: { name: 'New' },
    notes: null,
    tenant_id: null,
    product_id: null,
    recommendation_id: null,
    created_at: '2026-06-25T12:30:00.000Z',
    ...over,
  };
}

describe('buildAuditCsv (HUB-1617)', () => {
  it('emits a CRLF-terminated header row matching the spec columns (AC#3)', () => {
    const csv = buildAuditCsv([]);
    expect(csv).toBe(
      'Timestamp,Actor,Action,Entity Type,Entity ID,Detail\r\n',
    );
  });

  it('emits one CRLF-terminated data row per AuditRow', () => {
    const csv = buildAuditCsv([row(), row({ id: 'r-2', action: 'UPDATE' })]);
    const lines = csv.split('\r\n');
    // header + 2 rows + trailing empty string from final CRLF
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain('INSERT');
    expect(lines[2]).toContain('UPDATE');
    expect(lines[3]).toBe('');
  });

  it('quotes and doubles embedded quotes in Detail JSON (AC#7)', () => {
    const csv = buildAuditCsv([
      row({ notes: 'has a "quoted" word', after_value: null }),
    ]);
    // The JSON of {"notes":"has a \"quoted\" word"} contains commas+quotes, so
    // the whole field is wrapped and embedded quotes are doubled.
    expect(csv).toContain('"{""notes"":""has a \\""quoted\\"" word""}"');
  });

  it('preserves newlines inside quoted fields (AC#7)', () => {
    const csv = buildAuditCsv([
      row({ notes: 'line1\nline2', after_value: null }),
    ]);
    // The data row must wrap the multi-line Detail in quotes; the literal \n stays.
    expect(csv).toContain('"{""notes"":""line1\\nline2""}"');
  });

  it('passes commas in JSON through inside quoted fields (AC#7)', () => {
    const csv = buildAuditCsv([
      row({ after_value: { a: 1, b: 2 }, notes: null }),
    ]);
    expect(csv).toContain('"{""after"":{""a"":1,""b"":2}}"');
  });

  it('emits "—"-equivalent empty string when operator_id is null', () => {
    const csv = buildAuditCsv([row({ operator_id: null })]);
    const dataLine = csv.split('\r\n')[1];
    // Actor column (2nd column) is the empty string between two commas.
    const cols = dataLine.split(',');
    expect(cols[1]).toBe('');
  });

  it('includes the full Detail JSON, not the 80-char preview shown in the table (AC#3)', () => {
    const longNotes = 'x'.repeat(200);
    const csv = buildAuditCsv([row({ notes: longNotes, after_value: null })]);
    // Long enough that the on-screen preview would truncate; export must not.
    expect(csv).toContain(longNotes);
  });
});

describe('formatExportFilename (HUB-1617 AC#4)', () => {
  it('produces hub-audit-export-YYYYMMDD-HHmmss.csv', () => {
    const fixed = new Date('2026-06-25T08:09:07.000Z');
    // Use a UTC fixture but the function uses local time — assert the shape,
    // not the exact digits (which depend on the test runner TZ).
    const name = formatExportFilename(fixed);
    expect(name).toMatch(/^hub-audit-export-\d{8}-\d{6}\.csv$/);
  });

  it('zero-pads single-digit months / days / hours / minutes / seconds', () => {
    // 2026-03-04 05:06:07 LOCAL TIME (the function reads local fields). We build
    // a Date in local time by passing the components directly.
    const localDate = new Date(2026, 2, 4, 5, 6, 7); // month is 0-indexed
    expect(formatExportFilename(localDate)).toBe(
      'hub-audit-export-20260304-050607.csv',
    );
  });
});

describe('exportAuditCsv (HUB-1617)', () => {
  // jsdom doesn't implement URL.createObjectURL / revokeObjectURL — we assign
  // mocks directly (vi.spyOn can't spy on a non-existent property).
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:mock-url');
  const revokeObjectURL = vi.fn();
  let clickSpy: ReturnType<typeof vi.fn>;
  let originalClick: typeof HTMLAnchorElement.prototype.click;

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

  it('throws on empty rows so the disabled-button contract has a defense in depth (AC#6)', () => {
    expect(() => exportAuditCsv([])).toThrow(/empty/);
  });

  it('creates a Blob URL, clicks an anchor with the download attr, then revokes', () => {
    const filename = exportAuditCsv([row()], {
      now: new Date(2026, 5, 25, 12, 30, 0),
    });
    expect(filename).toBe('hub-audit-export-20260625-123000.csv');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  it('builds the Blob with text/csv mime type', () => {
    exportAuditCsv([row()]);
    const blobArg = createObjectURL.mock.calls[0][0] as Blob;
    expect(blobArg).toBeInstanceOf(Blob);
    expect(blobArg.type).toBe('text/csv;charset=utf-8');
  });
});
