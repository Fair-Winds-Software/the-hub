// Authorized by HUB-1803 (S1 of HUB-1785) — unit tests for the metric catalog.
// Verifies: registry well-formedness (no duplicate names, enum types have values),
// Zod wire schema validates realistic payloads and rejects malformed ones, per-metric
// value validation (int / float / enum) accepts and rejects correctly, dimension
// filtering drops non-catalog keys.
import { describe, it, expect } from 'vitest';
import {
  filterDimensions,
  getCatalogEntry,
  listCatalog,
  MetricEventInput,
  validateValue,
} from '../metricCatalog.js';

describe('metric catalog — well-formedness', () => {
  it('has no duplicate metric names', () => {
    const names = listCatalog().map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every enum-typed metric declares at least one value', () => {
    for (const entry of listCatalog()) {
      if (entry.type.startsWith('enum:')) {
        const values = entry.type.slice('enum:'.length).split('|');
        expect(values.length).toBeGreaterThan(0);
        for (const v of values) {
          expect(v.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('every entry has a non-empty description', () => {
    for (const entry of listCatalog()) {
      expect(entry.description.length).toBeGreaterThan(10);
    }
  });

  it('getCatalogEntry returns undefined for an unknown metric', () => {
    expect(getCatalogEntry('does_not_exist')).toBeUndefined();
  });

  it('getCatalogEntry returns the matching entry for a known metric', () => {
    const entry = getCatalogEntry('mrr_cents');
    expect(entry).toBeDefined();
    expect(entry!.type).toBe('int');
    expect(entry!.rollup).toBe('last');
  });
});

describe('MetricEventInput (Zod wire schema)', () => {
  it('accepts a realistic int metric payload', () => {
    const result = MetricEventInput.safeParse({
      product_id: '00000000-0000-4000-8000-000000000001',
      metric_name: 'mrr_cents',
      dimensions: { plan_id: 'plan_x' },
      value: 4900_00,
      occurred_at: '2026-07-13T00:00:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a realistic enum metric payload', () => {
    const result = MetricEventInput.safeParse({
      product_id: '00000000-0000-4000-8000-000000000001',
      metric_name: 'app_health_status',
      value: 'ok',
      occurred_at: '2026-07-13T00:00:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-uuid product_id', () => {
    const result = MetricEventInput.safeParse({
      product_id: 'not-a-uuid',
      metric_name: 'logins',
      value: 1,
      occurred_at: '2026-07-13T00:00:00Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing occurred_at', () => {
    const result = MetricEventInput.safeParse({
      product_id: '00000000-0000-4000-8000-000000000001',
      metric_name: 'logins',
      value: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe('validateValue — per-metric type checking', () => {
  it('int metric accepts integers, rejects floats + strings', () => {
    const entry = getCatalogEntry('mrr_cents')!;
    expect(validateValue(entry, 4900).ok).toBe(true);
    expect(validateValue(entry, 49.5).ok).toBe(false);
    expect(validateValue(entry, '4900').ok).toBe(false);
  });

  it('float metric accepts numbers, rejects strings + non-finite', () => {
    const entry = getCatalogEntry('churn_rate')!;
    expect(validateValue(entry, 0.031).ok).toBe(true);
    expect(validateValue(entry, 1).ok).toBe(true);
    expect(validateValue(entry, '0.031').ok).toBe(false);
    expect(validateValue(entry, Number.NaN).ok).toBe(false);
    expect(validateValue(entry, Number.POSITIVE_INFINITY).ok).toBe(false);
  });

  it('enum metric accepts declared values, rejects others + numbers', () => {
    const entry = getCatalogEntry('app_health_status')!;
    const ok = validateValue(entry, 'ok');
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value_str).toBe('ok');
      expect(ok.value_num).toBeNull();
    }
    expect(validateValue(entry, 'unknown_state').ok).toBe(false);
    expect(validateValue(entry, 1).ok).toBe(false);
  });

  it('int result populates value_num, not value_str', () => {
    const entry = getCatalogEntry('daily_active_users')!;
    const r = validateValue(entry, 812);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value_num).toBe(812);
      expect(r.value_str).toBeNull();
    }
  });
});

describe('filterDimensions', () => {
  it('drops keys not declared by the catalog entry', () => {
    const entry = getCatalogEntry('logins')!;
    const filtered = filterDimensions(entry, {
      operator_role: 'super_admin',
      not_declared: 'value',
    });
    expect(filtered).toEqual({ operator_role: 'super_admin' });
  });

  it('returns an empty object when the entry declares no dimensions', () => {
    const entry = getCatalogEntry('daily_active_users')!;
    const filtered = filterDimensions(entry, { anything: 'x' });
    expect(filtered).toEqual({});
  });

  it('handles undefined dimensions input', () => {
    const entry = getCatalogEntry('logins')!;
    expect(filterDimensions(entry, undefined)).toEqual({});
  });
});
