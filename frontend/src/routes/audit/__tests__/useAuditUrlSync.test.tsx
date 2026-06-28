// Authorized by HUB-1616 (E-FE-12 S6) — useAuditUrlSync hook tests. Covers URL → state
// seeding, default values for missing keys, malformed-value graceful fallback, state
// mirror to URL with replace:true, and non-filter URL key preservation (eventId).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { useAuditUrlSync, parseFilterState } from '../useAuditUrlSync';

afterEach(() => {
  cleanup();
});

// A tiny harness that exposes hook state + URL via DOM testids + lets callers mutate.
function Harness({
  capture,
  exposeSetState,
  exposeReset,
}: {
  capture?: (state: ReturnType<typeof useAuditUrlSync>['state']) => void;
  exposeSetState?: (
    fn: ReturnType<typeof useAuditUrlSync>['setState'],
  ) => void;
  exposeReset?: (fn: ReturnType<typeof useAuditUrlSync>['reset']) => void;
}) {
  const { state, setState, reset } = useAuditUrlSync();
  const location = useLocation();
  capture?.(state);
  exposeSetState?.(setState);
  exposeReset?.(reset);
  return (
    <div>
      <span data-testid="state">{JSON.stringify(state)}</span>
      <span data-testid="search">{location.search}</span>
    </div>
  );
}

describe('useAuditUrlSync (HUB-1616)', () => {
  describe('seed-from-URL on mount', () => {
    it('parses actor / action / entity_type / product_id / from / to / offset from URL', () => {
      const seen = vi.fn();
      render(
        <MemoryRouter
          initialEntries={[
            '/?actor=op-1&action=login,logout&entity_type=products,plans&product_id=p-1&from=2026-01-01&to=2026-06-01&offset=100',
          ]}
        >
          <Harness capture={seen} />
        </MemoryRouter>,
      );
      const state = JSON.parse(screen.getByTestId('state').textContent ?? '{}');
      expect(state).toMatchObject({
        actor: 'op-1',
        action: 'login,logout',
        entityType: 'products,plans',
        productId: 'p-1',
        from: '2026-01-01',
        to: '2026-06-01',
        offset: 100,
      });
      expect(seen).toHaveBeenCalled();
    });

    it('falls back to defaults (today-30d / today / offset=0) when URL has no filter keys', () => {
      render(
        <MemoryRouter initialEntries={['/']}>
          <Harness />
        </MemoryRouter>,
      );
      const state = JSON.parse(screen.getByTestId('state').textContent ?? '{}');
      expect(state.actor).toBe('');
      expect(state.action).toBe('');
      expect(state.offset).toBe(0);
      // Date range should span ~30 days
      const fromMs = new Date(state.from).getTime();
      const toMs = new Date(state.to).getTime();
      const diffDays = (toMs - fromMs) / (24 * 60 * 60 * 1000);
      expect(diffDays).toBeCloseTo(30, 0);
    });

    it('silently drops malformed values (invalid date, NaN offset)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      render(
        <MemoryRouter initialEntries={['/?from=garbage&offset=NotANumber']}>
          <Harness />
        </MemoryRouter>,
      );
      const state = JSON.parse(screen.getByTestId('state').textContent ?? '{}');
      // Malformed `from` falls back to today-30d (regex match fails).
      expect(state.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(state.offset).toBe(0);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('state changes mirror to URL', () => {
    it('setState writes filter keys back to the URL query string', () => {
      let setStateRef: ReturnType<typeof useAuditUrlSync>['setState'] | undefined;
      render(
        <MemoryRouter initialEntries={['/']}>
          <Harness exposeSetState={(fn) => (setStateRef = fn)} />
        </MemoryRouter>,
      );
      act(() => {
        setStateRef!((prev) => ({ ...prev, actor: 'op-99', action: 'INSERT' }));
      });
      const search = screen.getByTestId('search').textContent ?? '';
      expect(search).toContain('actor=op-99');
      expect(search).toContain('action=INSERT');
    });

    it('preserves non-filter URL params (eventId) when filter state changes', () => {
      let setStateRef: ReturnType<typeof useAuditUrlSync>['setState'] | undefined;
      render(
        <MemoryRouter initialEntries={['/?eventId=r-123']}>
          <Harness exposeSetState={(fn) => (setStateRef = fn)} />
        </MemoryRouter>,
      );
      act(() => {
        setStateRef!((prev) => ({ ...prev, actor: 'op-1' }));
      });
      const search = screen.getByTestId('search').textContent ?? '';
      expect(search).toContain('eventId=r-123');
      expect(search).toContain('actor=op-1');
    });
  });

  describe('reset', () => {
    it('clears filter keys; preserves eventId; date range returns to defaults', () => {
      let resetRef: ReturnType<typeof useAuditUrlSync>['reset'] | undefined;
      render(
        <MemoryRouter
          initialEntries={[
            '/?eventId=r-x&actor=op-1&from=2024-01-01&to=2024-12-31&offset=200',
          ]}
        >
          <Harness exposeReset={(fn) => (resetRef = fn)} />
        </MemoryRouter>,
      );
      act(() => {
        resetRef!();
      });
      const state = JSON.parse(screen.getByTestId('state').textContent ?? '{}');
      expect(state.actor).toBe('');
      expect(state.offset).toBe(0);
      const search = screen.getByTestId('search').textContent ?? '';
      expect(search).toContain('eventId=r-x'); // preserved
      expect(search).not.toContain('actor=');
    });
  });

  describe('parseFilterState (exported helper)', () => {
    it('returns default state for empty URLSearchParams', () => {
      const state = parseFilterState(new URLSearchParams());
      expect(state.actor).toBe('');
      expect(state.offset).toBe(0);
      expect(state.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});

// ─── Cross-Epic landing integration (HUB-1607 → HUB-1558) ────────────────────────
// Note: a full integration test would mount the Audit page with a deep-link URL and
// assert the AuditFilters fetch was issued with productId already set. That's covered
// indirectly by the AuditFilters test suite when the harness initialEntries has the
// productId param. The hook-level seed test above is the unit-level proof.

describe('Cross-Epic landing (HUB-1607 → HUB-1558 deep-link) (HUB-1616)', () => {
  it('URL ?productId=<id> seeds productId in state on mount (AC#6)', () => {
    render(
      <MemoryRouter initialEntries={['/?product_id=p-from-1607']}>
        <Harness />
      </MemoryRouter>,
    );
    const state = JSON.parse(screen.getByTestId('state').textContent ?? '{}');
    expect(state.productId).toBe('p-from-1607');
  });
});

// Suppress "unused" warning from the imported useState (kept for future tests if needed).
void useState;
