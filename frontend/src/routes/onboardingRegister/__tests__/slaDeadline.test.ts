// Authorized by HUB-1397 (E-CMP-WAVE4 S4) — SLA urgency computation tests.
import { describe, it, expect } from 'vitest';
import { daysUntilSla, slaUrgency } from '../slaDeadline';

const NOW = Date.parse('2026-07-05T12:00:00Z');

describe('daysUntilSla', () => {
  it('returns positive count for a future deadline', () => {
    expect(daysUntilSla('2026-07-12', NOW)).toBe(7);
  });
  it('returns 0 (or -0) for the same-day deadline', () => {
    // 2026-07-05 UTC midnight is 12h before NOW → -0.5 days, ceiling gives -0.
    // The urgency mapper then classifies this as 'due_soon' — see slaUrgency() test.
    const days = daysUntilSla('2026-07-05', NOW);
    expect(Object.is(days, 0) || Object.is(days, -0)).toBe(true);
  });
  it('returns negative for a past deadline', () => {
    expect(daysUntilSla('2026-06-30', NOW)).toBeLessThan(0);
  });
});

describe('slaUrgency', () => {
  it('negative → overdue', () => {
    expect(slaUrgency(-1)).toBe('overdue');
    expect(slaUrgency(-30)).toBe('overdue');
  });
  it('0..3 → due_soon', () => {
    expect(slaUrgency(0)).toBe('due_soon');
    expect(slaUrgency(3)).toBe('due_soon');
  });
  it('>3 → normal', () => {
    expect(slaUrgency(4)).toBe('normal');
    expect(slaUrgency(10)).toBe('normal');
  });
});
