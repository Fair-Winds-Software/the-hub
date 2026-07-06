// Authorized by HUB-1398 (E-CMP-WAVE4 S5) — revocation urgency helper unit tests.
import { describe, it, expect } from 'vitest';
import { hoursUntilRevocation, revocationUrgency } from '../revocationUrgency';

const NOW = Date.parse('2026-07-05T12:00:00Z');

describe('hoursUntilRevocation', () => {
  it('returns positive count for future deadlines', () => {
    expect(hoursUntilRevocation('2026-07-05T18:00:00Z', NOW)).toBe(6);
  });
  it('returns negative for past deadlines', () => {
    expect(hoursUntilRevocation('2026-07-05T10:00:00Z', NOW)).toBe(-2);
  });
});

describe('revocationUrgency', () => {
  it('negative → overdue', () => {
    expect(revocationUrgency(-0.5)).toBe('overdue');
  });
  it('0..2 → due_soon', () => {
    expect(revocationUrgency(0)).toBe('due_soon');
    expect(revocationUrgency(1.9)).toBe('due_soon');
    expect(revocationUrgency(2)).toBe('due_soon');
  });
  it('>2 → normal', () => {
    expect(revocationUrgency(2.1)).toBe('normal');
    expect(revocationUrgency(24)).toBe('normal');
  });
});
