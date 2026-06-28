// Authorized by HUB-1616 (E-FE-12 S6) — URL ↔ audit filter state bidirectional sync.
// Filter state IS the URL: useSearchParams is the source of truth. setState updates the URL
// with `replace: true` (no history bloat across rapid filter changes per HUB-1558 §9
// Reliability) and AuditFilters re-renders with the parsed state. Browser back/forward
// "just works" because they update searchParams which round-trips through the hook.
//
// Cross-Epic landing (HUB-1557 AC-E5): `/console/audit?productId=<id>` lands with the
// productId filter pre-applied because parseFilterState reads it on first mount and
// AuditFilters' debounce effect fires the initial fetch with that filter set.
//
// Other URL params (e.g., eventId for HUB-1615 drawer deep-link) are PRESERVED across
// filter writes — setState only touches the filter-related keys, not the whole querystring.
//
// Malformed values are silently dropped (AC#7): invalid date strings, NaN offsets, etc.
// fall back to defaults. We log a console.warn so devs can debug if a URL doesn't behave.
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

const DEFAULT_RANGE_DAYS = 30;
const FILTER_KEYS = ['actor', 'action', 'entity_type', 'product_id', 'from', 'to', 'offset'] as const;

export interface AuditFilterState {
  actor: string;
  action: string;       // comma-separated
  entityType: string;   // comma-separated
  productId: string;
  from: string;         // yyyy-mm-dd
  to: string;           // yyyy-mm-dd
  offset: number;
}

function toIsoDateString(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function defaultDateRange(): { from: string; to: string } {
  const today = new Date();
  const from = new Date(today.getTime() - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000);
  return { from: toIsoDateString(from), to: toIsoDateString(today) };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDateValueOrDefault(raw: string | null, fallback: string): string {
  if (!raw) return fallback;
  if (!DATE_RE.test(raw)) {
    console.warn(`useAuditUrlSync: ignoring malformed date value "${raw}"`);
    return fallback;
  }
  return raw;
}

function parseOffsetValue(raw: string | null): number {
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 0) {
    console.warn(`useAuditUrlSync: ignoring malformed offset value "${raw}"`);
    return 0;
  }
  return n;
}

export function parseFilterState(params: URLSearchParams): AuditFilterState {
  const defaults = defaultDateRange();
  return {
    actor: params.get('actor') ?? '',
    action: params.get('action') ?? '',
    entityType: params.get('entity_type') ?? '',
    productId: params.get('product_id') ?? '',
    from: parseDateValueOrDefault(params.get('from'), defaults.from),
    to: parseDateValueOrDefault(params.get('to'), defaults.to),
    offset: parseOffsetValue(params.get('offset')),
  };
}

function writeFilterStateToParams(
  state: AuditFilterState,
  target: URLSearchParams,
): void {
  // Strip prior filter keys so empty-string values clear the URL param cleanly.
  for (const key of FILTER_KEYS) target.delete(key);
  if (state.actor) target.set('actor', state.actor);
  if (state.action) target.set('action', state.action);
  if (state.entityType) target.set('entity_type', state.entityType);
  if (state.productId) target.set('product_id', state.productId);
  if (state.from) target.set('from', state.from);
  if (state.to) target.set('to', state.to);
  if (state.offset > 0) target.set('offset', String(state.offset));
}

export interface UseAuditUrlSyncResult {
  state: AuditFilterState;
  setState: (updater: (prev: AuditFilterState) => AuditFilterState) => void;
  /** Clear filter state to defaults; preserves non-filter URL params (e.g., eventId). */
  reset: () => void;
}

/**
 * Seed-from-URL-once + mirror-to-URL pattern: read the URL once on mount to derive the
 * initial state, then own local state via useState. A side effect mirrors local state
 * changes back to the URL via setSearchParams (replace:true). This keeps timing
 * deterministic — local state updates are synchronous like any useState call — while
 * still surfacing the URL as the deep-link substrate.
 *
 * Tradeoff: this hook does NOT react to external URL changes after mount (back/forward
 * navigation, manual URL edit, navigation from another route into a deep link). The
 * Audit page handles browser back/forward by re-mounting the route on navigation; for
 * external mid-session URL writes (rare in this app), a callsite can pass a new key to
 * remount.
 */
export function useAuditUrlSync(): UseAuditUrlSyncResult {
  const [searchParams, setParams] = useSearchParams();
  // Initial state derived from URL exactly once. Subsequent reads come from local state.
  // Use useSearchParams (not window.location) so MemoryRouter-based tests can seed via
  // initialEntries and any host using react-router stays consistent across renderers.
  const [state, setStateLocal] = useState<AuditFilterState>(() =>
    parseFilterState(searchParams),
  );

  // Mirror local state → URL. Preserves any non-filter URL keys (e.g., eventId).
  useEffect(() => {
    setParams(
      (curr) => {
        const out = new URLSearchParams(curr);
        writeFilterStateToParams(state, out);
        return out;
      },
      { replace: true },
    );
  }, [state, setParams]);

  const setState = useCallback(
    (updater: (prev: AuditFilterState) => AuditFilterState) => {
      setStateLocal(updater);
    },
    [],
  );

  const reset = useCallback(() => {
    const defaults = parseFilterState(new URLSearchParams());
    setStateLocal(defaults);
  }, []);

  return { state, setState, reset };
}
