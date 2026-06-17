// Authorized by HUB-1057 — unit tests for ragStatus() boundary cases and tscPrefix() category normalisation
import { describe, it, expect } from 'vitest';
import { ragStatus, tscPrefix } from '../complianceDashboardService.js';

// ── ragStatus() ────────────────────────────────────────────────────────────────

describe('ragStatus()', () => {
  it('returns green at exactly 90', () => {
    expect(ragStatus(90)).toBe('green');
  });

  it('returns green above 90', () => {
    expect(ragStatus(100)).toBe('green');
  });

  it('returns green at 95.5', () => {
    expect(ragStatus(95.5)).toBe('green');
  });

  it('returns amber at exactly 89', () => {
    expect(ragStatus(89)).toBe('amber');
  });

  it('returns amber at exactly 70', () => {
    expect(ragStatus(70)).toBe('amber');
  });

  it('returns amber at 75', () => {
    expect(ragStatus(75)).toBe('amber');
  });

  it('returns red at exactly 69', () => {
    expect(ragStatus(69)).toBe('red');
  });

  it('returns red at 0', () => {
    expect(ragStatus(0)).toBe('red');
  });

  it('returns red at 50', () => {
    expect(ragStatus(50)).toBe('red');
  });
});

// ── tscPrefix() ────────────────────────────────────────────────────────────────

describe('tscPrefix()', () => {
  it('CC6.1 → CC6', () => {
    expect(tscPrefix('CC6.1')).toBe('CC6');
  });

  it('CC7 → CC7 (no decimal, CC category passes through)', () => {
    expect(tscPrefix('CC7')).toBe('CC7');
  });

  it('CC9.2 → CC9', () => {
    expect(tscPrefix('CC9.2')).toBe('CC9');
  });

  it('A1 → A', () => {
    expect(tscPrefix('A1')).toBe('A');
  });

  it('C1 → C', () => {
    expect(tscPrefix('C1')).toBe('C');
  });

  it('PI1 → PI', () => {
    expect(tscPrefix('PI1')).toBe('PI');
  });

  it('OVERALL → OVERALL', () => {
    expect(tscPrefix('OVERALL')).toBe('OVERALL');
  });

  it('P1 → P', () => {
    expect(tscPrefix('P1')).toBe('P');
  });
});
