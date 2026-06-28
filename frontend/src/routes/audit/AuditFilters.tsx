// Authorized by HUB-1613 (E-FE-12 S3) — audit filter controls + 300ms debounced fetch.
// Owns the 5 filter groups (actor / action / entity_type / product / date range), the
// debounced submit pipeline, and the live API call to the canonical audit-log endpoint.
//
// Surfaces results + loading + error to the parent via callbacks (onResults +
// onLoadingChange). The S4 result table (HUB-1614) and S6 URL sync (HUB-1616) will hook in
// at the parent level.
//
// Spec deviations (documented per ironclad-engineer):
// 1. Product endpoint: `/api/v1/admin/portfolio/products` (canonical from HUB-1700) — spec
//    said `/admin/products` which doesn't exist as a flat endpoint.
// 2. Action + entity_type rendered as comma-separated free-text inputs, NOT enum
//    multi-selects. operator_audit_log.action + .entity_type are TEXT columns with no fixed
//    enum (values are free-form: 'create', 'apply_discount', 'INSERT', etc.). Enum dropdowns
//    would either miss values or hardcode wrong assumptions. Free-text matches BE reality.
// 3. Wire-format: HUB-1697 BE accepts snake_case query params (tenant_id, product_id,
//    entity_type, etc.). Spec wrote camelCase. FE sends what BE actually accepts.
// 4. tenant_id required: HUB-1697 BE requires tenant_id for every call. FE always passes the
//    HUB-internal sentinel ('0...0a1') per HUB-1704 convention.
// 5. Actor dropdown degrades to free-text input when the operators endpoint returns 403
//    (super_admin-only per HUB-1058). product_admin sees a free-text field instead.
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { apiClient } from '../../lib/api';
import { PermissionDeniedError } from '../../lib/errors';
import {
  parseFilterState,
  useAuditUrlSync,
  type AuditFilterState,
} from './useAuditUrlSync';

const DEBOUNCE_MS = 300;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
// HUB-internal sentinel tenant (HUB-1704 convention). The audit-log endpoint requires
// tenant_id on every request; HUB-internal audit data is scoped to this single tenant.
const HUB_INTERNAL_TENANT_ID = '00000000-0000-0000-0000-0000000000a1';

const AUDIT_LOG_PATH = '/api/v1/admin/console/audit-log';
const OPERATORS_PATH = '/api/v1/admin/operators';
const PRODUCTS_PATH = '/api/v1/admin/portfolio/products';

export interface AuditRow {
  id: string;
  operator_id: string | null;
  entity_type: string;
  entity_id: string;
  action: string;
  before_value: unknown;
  after_value: unknown;
  notes: string | null;
  tenant_id: string | null;
  product_id: string | null;
  recommendation_id: string | null;
  created_at: string;
}

interface AuditLogResponse {
  data: AuditRow[];
  total: number;
  limit: number;
  offset: number;
}

interface OperatorListItem {
  id: string;
  email: string;
  role: string;
}

interface PortfolioProductListItem {
  productId: string;
  productName: string;
}

interface PortfolioProductsResponse {
  data: PortfolioProductListItem[];
  total: number;
}

export interface AuditFiltersProps {
  /**
   * Called when a fetch completes (success or failure). On success: data + total. On
   * failure: data=null, total=0, and error contains a user-facing message.
   */
  onResults: (data: AuditRow[] | null, total: number, error?: string) => void;
  /** Fires true immediately before fetch, false after fetch resolves (success or failure). */
  onLoadingChange: (loading: boolean) => void;
}

// FilterState shape lifted to useAuditUrlSync (AuditFilterState) so URL is the source
// of truth. Re-exported here as an alias for any AuditFilters consumer that still
// imports the old name.
type FilterState = AuditFilterState;

/** Comma-split + trim + drop empties. */
function splitCsv(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function buildAuditLogQuery(state: FilterState): string {
  const params = new URLSearchParams();
  params.set('tenant_id', HUB_INTERNAL_TENANT_ID);
  if (state.actor) params.set('actor', state.actor);
  const actions = splitCsv(state.action);
  if (actions.length > 0) params.set('action', actions.join(','));
  const entityTypes = splitCsv(state.entityType);
  if (entityTypes.length > 0) params.set('entity_type', entityTypes.join(','));
  if (state.productId) params.set('product_id', state.productId);
  if (state.from) params.set('from', state.from);
  if (state.to) params.set('to', state.to);
  return params.toString();
}

export function AuditFilters({
  onResults,
  onLoadingChange,
}: AuditFiltersProps): React.ReactElement {
  // HUB-1616: URL is the source of truth for filter state. AuditFilters reads + writes
  // through the hook; deep-links (?productId=p1 etc.) land with the filter pre-applied;
  // setState calls write with replace:true to avoid history bloat across rapid changes.
  const { state, setState, reset: resetUrl } = useAuditUrlSync();
  const [operators, setOperators] = useState<OperatorListItem[]>([]);
  const [products, setProducts] = useState<PortfolioProductListItem[]>([]);
  const [operatorsForbidden, setOperatorsForbidden] = useState(false);

  // Stable IDs for label↔input wiring (avoids id collisions if the component mounts twice).
  const actorId = useId();
  const actionId = useId();
  const entityTypeId = useId();
  const productIdId = useId();
  const fromId = useId();
  const toId = useId();
  const dateErrorId = useId();
  const dateWarningId = useId();

  // Debounce timer + a ref to the latest state so the timer callback fires with fresh data.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  // ── Date range validation (memoized via derived values; cheap to recompute) ─
  const fromMs = state.from ? new Date(state.from).getTime() : NaN;
  const toMs = state.to ? new Date(state.to).getTime() : NaN;
  const datesPresent = !isNaN(fromMs) && !isNaN(toMs);
  const dateRangeInverted = datesPresent && fromMs > toMs;
  const dateRangeWarning = datesPresent && !dateRangeInverted && toMs - fromMs > ONE_YEAR_MS;

  // ── The actual fetch — extracted so reset can call it immediately ───────────
  const runFetch = useCallback(
    async (snapshot: FilterState): Promise<void> => {
      onLoadingChange(true);
      try {
        const qs = buildAuditLogQuery(snapshot);
        const result = await apiClient.get<AuditLogResponse>(
          `${AUDIT_LOG_PATH}?${qs}`,
        );
        onResults(result.data, result.total);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to load audit log';
        onResults(null, 0, message);
      } finally {
        onLoadingChange(false);
      }
    },
    [onLoadingChange, onResults],
  );

  // ── Schedule a debounced fetch on state change (skip when dates inverted) ───
  useEffect(() => {
    if (dateRangeInverted) return;
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
    }
    const t = setTimeout(() => {
      void runFetch(stateRef.current);
    }, DEBOUNCE_MS);
    debounceRef.current = t;
    return () => {
      clearTimeout(t);
    };
  }, [
    state.actor,
    state.action,
    state.entityType,
    state.productId,
    state.from,
    state.to,
    dateRangeInverted,
    runFetch,
  ]);

  // ── Mount: load dropdown data in parallel; degrade actor → free text on 403 ─
  useEffect(() => {
    let cancelled = false;

    void apiClient
      .get<OperatorListItem[]>(OPERATORS_PATH)
      .then((rows) => {
        if (!cancelled) setOperators(rows);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof PermissionDeniedError) {
          // product_admin: operators endpoint is super_admin-only. Degrade to free-text.
          setOperatorsForbidden(true);
        }
      });

    void apiClient
      .get<PortfolioProductsResponse>(PRODUCTS_PATH)
      .then((res) => {
        if (!cancelled) setProducts(res.data);
      })
      .catch(() => {
        // Products fetch failure is non-fatal; product dropdown stays empty.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const updateField = useCallback(<K extends keyof FilterState>(
    field: K,
    value: FilterState[K],
  ) => {
    setState((prev) => ({ ...prev, [field]: value }));
  }, []);

  const handleReset = useCallback(() => {
    // Compute defaults synchronously so we can fire the fetch immediately without
    // waiting for the URL update → re-render cycle.
    const defaults = parseFilterState(new URLSearchParams());
    resetUrl();
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    void runFetch(defaults);
  }, [runFetch, resetUrl]);

  // The form element exists to expose a single submit boundary for assistive tech; the
  // submit itself is a no-op because state changes auto-fetch via the debounce effect.
  const handleSubmit = useCallback((e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
  }, []);

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-4 rounded-md border border-mist bg-sailcloth p-4"
      aria-label="Audit log filters"
    >
      <h2 className="font-heading text-lg text-primary-navy">Filters</h2>

      {/* Actor — dropdown when operators load OK; free text on 403 */}
      <div>
        <label htmlFor={actorId} className="block text-sm font-body text-deep-charcoal mb-1">
          Actor
        </label>
        {operatorsForbidden ? (
          <input
            id={actorId}
            type="text"
            value={state.actor}
            onChange={(e) => updateField('actor', e.target.value)}
            placeholder="Operator ID (substring)"
            className="block w-full rounded border border-mist bg-sailcloth p-2 text-sm font-body text-deep-charcoal focus:outline-none focus:ring-2 focus:ring-primary-brass"
          />
        ) : (
          <select
            id={actorId}
            value={state.actor}
            onChange={(e) => updateField('actor', e.target.value)}
            className="block w-full rounded border border-mist bg-sailcloth p-2 text-sm font-body text-deep-charcoal focus:outline-none focus:ring-2 focus:ring-primary-brass"
          >
            <option value="">All actors</option>
            {operators.map((op) => (
              <option key={op.id} value={op.id}>
                {op.email} ({op.role})
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Action — comma-separated free text */}
      <div>
        <label htmlFor={actionId} className="block text-sm font-body text-deep-charcoal mb-1">
          Action
        </label>
        <input
          id={actionId}
          type="text"
          value={state.action}
          onChange={(e) => updateField('action', e.target.value)}
          placeholder="e.g. INSERT, apply_discount"
          aria-describedby={`${actionId}-hint`}
          className="block w-full rounded border border-mist bg-sailcloth p-2 text-sm font-body text-deep-charcoal focus:outline-none focus:ring-2 focus:ring-primary-brass"
        />
        <p id={`${actionId}-hint`} className="mt-1 text-xs text-deep-charcoal/60">
          Comma-separated; matches any.
        </p>
      </div>

      {/* Entity type — comma-separated free text */}
      <div>
        <label
          htmlFor={entityTypeId}
          className="block text-sm font-body text-deep-charcoal mb-1"
        >
          Entity type
        </label>
        <input
          id={entityTypeId}
          type="text"
          value={state.entityType}
          onChange={(e) => updateField('entityType', e.target.value)}
          placeholder="e.g. products, operator_accounts"
          aria-describedby={`${entityTypeId}-hint`}
          className="block w-full rounded border border-mist bg-sailcloth p-2 text-sm font-body text-deep-charcoal focus:outline-none focus:ring-2 focus:ring-primary-brass"
        />
        <p id={`${entityTypeId}-hint`} className="mt-1 text-xs text-deep-charcoal/60">
          Comma-separated; matches any.
        </p>
      </div>

      {/* Product */}
      <div>
        <label
          htmlFor={productIdId}
          className="block text-sm font-body text-deep-charcoal mb-1"
        >
          Product
        </label>
        <select
          id={productIdId}
          value={state.productId}
          onChange={(e) => updateField('productId', e.target.value)}
          className="block w-full rounded border border-mist bg-sailcloth p-2 text-sm font-body text-deep-charcoal focus:outline-none focus:ring-2 focus:ring-primary-brass"
        >
          <option value="">All products</option>
          {products.map((p) => (
            <option key={p.productId} value={p.productId}>
              {p.productName}
            </option>
          ))}
        </select>
      </div>

      {/* Date range */}
      <fieldset>
        <legend className="text-sm font-body text-deep-charcoal mb-1">Date range</legend>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label htmlFor={fromId} className="block text-xs text-deep-charcoal/70 mb-1">
              From
            </label>
            <input
              id={fromId}
              type="date"
              value={state.from}
              onChange={(e) => updateField('from', e.target.value)}
              aria-invalid={dateRangeInverted}
              aria-describedby={dateRangeInverted ? dateErrorId : dateRangeWarning ? dateWarningId : undefined}
              className="block w-full rounded border border-mist bg-sailcloth p-2 text-sm font-body text-deep-charcoal focus:outline-none focus:ring-2 focus:ring-primary-brass"
            />
          </div>
          <div>
            <label htmlFor={toId} className="block text-xs text-deep-charcoal/70 mb-1">
              To
            </label>
            <input
              id={toId}
              type="date"
              value={state.to}
              onChange={(e) => updateField('to', e.target.value)}
              aria-invalid={dateRangeInverted}
              aria-describedby={dateRangeInverted ? dateErrorId : dateRangeWarning ? dateWarningId : undefined}
              className="block w-full rounded border border-mist bg-sailcloth p-2 text-sm font-body text-deep-charcoal focus:outline-none focus:ring-2 focus:ring-primary-brass"
            />
          </div>
        </div>
        {dateRangeInverted ? (
          <p id={dateErrorId} role="alert" className="mt-2 text-sm text-red-700">
            &ldquo;From&rdquo; must be on or before &ldquo;To&rdquo;.
          </p>
        ) : dateRangeWarning ? (
          <p id={dateWarningId} className="mt-2 text-sm text-amber-700">
            Date range exceeds 1 year — the query may be slow.
          </p>
        ) : null}
      </fieldset>

      <div className="flex gap-2 pt-2">
        <button
          type="button"
          onClick={handleReset}
          className="rounded border border-mist bg-sailcloth px-3 py-2 text-sm font-body text-primary-navy hover:bg-mist focus:outline-none focus:ring-2 focus:ring-primary-brass"
        >
          Reset filters
        </button>
      </div>
    </form>
  );
}
