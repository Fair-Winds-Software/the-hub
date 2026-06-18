// Authorized by HUB-1381 — unit tests for buildCoverDocument() cover document generator
// Authorized by HUB-1383 — unit tests for evidence export service utilities
import { describe, it, expect } from 'vitest';
import { buildCoverDocument } from '../evidenceExportService.js';
import type { EvidenceRecord, ExportFilters } from '../evidenceExportService.js';

const baseFilters: ExportFilters = {
  dateFrom: new Date('2026-01-01T00:00:00Z'),
  dateTo: new Date('2026-01-31T23:59:59Z'),
};

function makeRecord(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    product_id: 'prod-1',
    control_id: 'ctrl-1',
    signal_id: 'sig-001',
    content_hash: 'abc123',
    payload: { source: 'test' },
    signal_type: 'automated',
    observed_at: new Date('2026-01-15T12:00:00Z'),
    received_at: new Date('2026-01-15T12:00:01Z'),
    is_burn_in_gap: false,
    control_key: 'CC6.1',
    control_name: 'Test Control',
    tsc_category: 'CC6',
    control_class: 'automated',
    ...overrides,
  };
}

describe('buildCoverDocument()', () => {
  it('includes the job ID in the output', () => {
    const doc = buildCoverDocument('test-job-123', baseFilters, [], []);
    expect(doc).toContain('test-job-123');
  });

  it('includes the date range', () => {
    const doc = buildCoverDocument('job-1', baseFilters, [], []);
    expect(doc).toContain('2026-01-01');
    expect(doc).toContain('2026-01-31');
  });

  it('includes total evidence record count', () => {
    const records = [makeRecord(), makeRecord({ signal_id: 'sig-002' })];
    const doc = buildCoverDocument('job-1', baseFilters, records, []);
    expect(doc).toContain('2');
  });

  it('shows category pass rates when verdicts are present', () => {
    const verdicts = [
      { tsc_category: 'CC6', verdict: 'pass', control_key: 'CC6.1', product_id: 'p1', evaluated_at: '2026-01-15' },
      { tsc_category: 'CC6', verdict: 'pass', control_key: 'CC6.1', product_id: 'p1', evaluated_at: '2026-01-16' },
      { tsc_category: 'CC6', verdict: 'fail', control_key: 'CC6.2', product_id: 'p1', evaluated_at: '2026-01-17' },
      { tsc_category: 'A1', verdict: 'pass', control_key: 'A1.1', product_id: 'p1', evaluated_at: '2026-01-15' },
    ];
    const doc = buildCoverDocument('job-1', baseFilters, [], verdicts);
    expect(doc).toContain('CC6');
    expect(doc).toContain('A1');
    expect(doc).toContain('66.7%'); // 2/3 for CC6
    expect(doc).toContain('100.0%'); // 1/1 for A1
  });

  it('shows FAIL events table when failures exist', () => {
    const verdicts = [
      { tsc_category: 'CC6', verdict: 'fail', control_key: 'CC6.2', product_id: 'p1', evaluated_at: '2026-01-17' },
    ];
    const doc = buildCoverDocument('job-1', baseFilters, [], verdicts);
    expect(doc).toContain('CC6.2');
    expect(doc).toContain('fail');
  });

  it('shows "No FAIL or overdue events" when all verdicts pass', () => {
    const verdicts = [
      { tsc_category: 'CC6', verdict: 'pass', control_key: 'CC6.1', product_id: 'p1', evaluated_at: '2026-01-15' },
    ];
    const doc = buildCoverDocument('job-1', baseFilters, [], verdicts);
    expect(doc).toContain('No FAIL or overdue events');
  });

  it('shows no-verdicts placeholder when verdict list is empty', () => {
    const doc = buildCoverDocument('job-1', baseFilters, [], []);
    expect(doc).toContain('no verdicts in period');
  });

  it('includes product filter when provided', () => {
    const filters: ExportFilters = { ...baseFilters, productId: 'prod-abc' };
    const doc = buildCoverDocument('job-1', filters, [], []);
    expect(doc).toContain('prod-abc');
  });

  it('shows All products when no product filter', () => {
    const doc = buildCoverDocument('job-1', baseFilters, [], []);
    expect(doc).toContain('All products');
  });

  it('includes bundle integrity section', () => {
    const doc = buildCoverDocument('job-1', baseFilters, [], []);
    expect(doc).toContain('manifest.json');
    expect(doc).toContain('manifest.signature');
    expect(doc).toContain('SHA-256');
  });
});
