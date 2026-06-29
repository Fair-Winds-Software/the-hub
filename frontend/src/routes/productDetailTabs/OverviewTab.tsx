// Authorized by HUB-1605 (E-FE-3 S5) — Overview tab inside the HUB-1604 product
// detail. Displays the per-product metadata available at v0.1 and provides the
// inline-edit affordance for Status (PATCH /api/v1/admin/products/:productId).
//
// Spec deviations (documented per ironclad-engineer):
// 1. Contact-email inline edit: SKIPPED at v0.1 — the products table schema
//    (db/migrations/001) has no contact_email column and the API does not surface
//    one. The spec field is reduced to a placeholder cell that reads "—" with a
//    note that the field will be wired when the BE schema adds the column. Flag
//    captured under HUB-1545 Tech Debt (BE) per the spec's "if missing → flag"
//    contingency for the health endpoint, applied here by the same rule.
// 2. Version field: SAME as the list view. The products schema does not carry an
//    SDK version at v0.1; cell renders "—".
// 3. API Health endpoint: GET /api/v1/admin/products/:productId/health does not
//    exist at v0.1 (verified against routes/admin/products.ts). The lazy probe
//    issues the call; on 404 / network failure the cell degrades to "unavailable"
//    with a tooltip. Pending BE story under HUB-1545 Tech Debt per the spec's
//    explicit contingency.
// 4. Inline-edit Status PATCH: spec calls for PATCH /api/v1/admin/products/:id.
//    Endpoint does not exist at v0.1. The save path is implemented in full per
//    spec; when the endpoint lands, no FE changes needed. Until then the failure
//    path (revert + inline "Unable to save" message) is what operators see, which
//    matches the spec's documented v0.1 acceptable behavior.
// 5. Last-write-wins per HUB-1557 §9 Risk-2 — no optimistic concurrency at v0.1.
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { apiClient } from '../../lib/api';
import type { PortfolioProduct } from '../Products';

const PATCH_PATH = (productId: string): string =>
  `/api/v1/admin/products/${productId}`;
const HEALTH_PATH = (productId: string): string =>
  `/api/v1/admin/products/${productId}/health`;

const STATUS_OPTIONS = ['active', 'inactive', 'archived'] as const;

interface HealthResponse {
  available: boolean;
  reason?: string;
}

type HealthState =
  | { kind: 'loading' }
  | { kind: 'ok' }
  | { kind: 'unavailable'; reason?: string };

export interface OverviewTabProps {
  product: PortfolioProduct;
  /**
   * Fires after a successful inline-edit save so the parent can mirror the
   * change in its own local state (the page header status badge, etc.).
   */
  onProductChange?: (next: PortfolioProduct) => void;
}

function formatDollars(cents: number): string {
  if (!Number.isFinite(cents) || cents <= 0) return '$0';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString();
}

function FieldRow({
  label,
  children,
  testId,
}: {
  label: string;
  children: React.ReactNode;
  testId?: string;
}): React.ReactElement {
  return (
    <div
      data-testid={testId}
      className="grid grid-cols-[140px_1fr] items-center gap-3 border-b border-deep-charcoal/10 py-2 last:border-b-0"
    >
      <dt className="font-body text-sm text-deep-charcoal/70">{label}</dt>
      <dd className="font-body text-sm text-deep-charcoal">{children}</dd>
    </div>
  );
}

export function OverviewTab({
  product,
  onProductChange,
}: OverviewTabProps): React.ReactElement {
  const [status, setStatus] = useState(product.status);
  const [editingStatus, setEditingStatus] = useState(false);
  const [statusSaveError, setStatusSaveError] = useState<string | null>(null);
  const [savingStatus, setSavingStatus] = useState(false);
  const [health, setHealth] = useState<HealthState>({ kind: 'loading' });

  const statusSelectId = useId();
  const ariaLiveId = useId();
  const cancelledRef = useRef(false);
  const statusSelectRef = useRef<HTMLSelectElement | null>(null);

  // Programmatic focus when entering edit mode — preferable to autoFocus per
  // jsx-a11y/no-autofocus: an explicit operator action (clicking the pencil)
  // is what requests focus, so the SR experience is "expected and announced."
  useEffect(() => {
    if (editingStatus && statusSelectRef.current) {
      statusSelectRef.current.focus();
    }
  }, [editingStatus]);

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  // Keep local status in sync when the parent's product changes underneath us
  // (e.g., parent re-fetches and replaces the row).
  useEffect(() => {
    setStatus(product.status);
  }, [product.status]);

  // Lazy health probe. Graceful degradation when the endpoint is missing
  // (HUB-1545 Tech Debt) — 404/network fallback to "unavailable".
  useEffect(() => {
    let cancelled = false;
    setHealth({ kind: 'loading' });
    void apiClient
      .get<HealthResponse>(HEALTH_PATH(product.productId))
      .then((res) => {
        if (cancelled) return;
        if (res.available) {
          setHealth({ kind: 'ok' });
        } else {
          setHealth({ kind: 'unavailable', reason: res.reason });
        }
      })
      .catch(() => {
        if (cancelled) return;
        setHealth({ kind: 'unavailable' });
      });
    return () => {
      cancelled = true;
    };
  }, [product.productId]);

  const startEditingStatus = useCallback(() => {
    setStatusSaveError(null);
    setEditingStatus(true);
  }, []);

  const cancelEditingStatus = useCallback(() => {
    setStatus(product.status);
    setStatusSaveError(null);
    setEditingStatus(false);
  }, [product.status]);

  const saveStatus = useCallback(
    async (nextStatus: string): Promise<void> => {
      if (nextStatus === product.status) {
        setEditingStatus(false);
        return;
      }
      setSavingStatus(true);
      setStatusSaveError(null);
      // Optimistic update.
      setStatus(nextStatus);
      try {
        await apiClient.patch(PATCH_PATH(product.productId), {
          status: nextStatus,
        });
        if (cancelledRef.current) return;
        setEditingStatus(false);
        onProductChange?.({ ...product, status: nextStatus });
      } catch (err) {
        if (cancelledRef.current) return;
        // Revert.
        setStatus(product.status);
        const message =
          err instanceof Error ? err.message : 'Unable to save. Retry?';
        setStatusSaveError(message);
      } finally {
        if (!cancelledRef.current) setSavingStatus(false);
      }
    },
    [product, onProductChange],
  );

  const handleStatusKeyDown = useCallback(
    (event: KeyboardEvent<HTMLSelectElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelEditingStatus();
      }
    },
    [cancelEditingStatus],
  );

  const healthLabel =
    health.kind === 'loading'
      ? 'checking…'
      : health.kind === 'ok'
        ? 'OK'
        : 'unavailable';

  return (
    <div
      data-testid="overview-tab"
      className="flex flex-col gap-4 p-4"
    >
      <dl className="flex flex-col gap-0">
        <FieldRow label="Status" testId="overview-field-status">
          {editingStatus ? (
            <div className="flex items-center gap-2">
              <label htmlFor={statusSelectId} className="sr-only">
                Status
              </label>
              <select
                id={statusSelectId}
                ref={statusSelectRef}
                data-testid="overview-status-select"
                value={status}
                disabled={savingStatus}
                onChange={(e) => void saveStatus(e.target.value)}
                onBlur={() => {
                  if (!savingStatus) setEditingStatus(false);
                }}
                onKeyDown={handleStatusKeyDown}
                className="rounded border border-deep-charcoal/20 bg-white p-1 text-sm font-body text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              {savingStatus && (
                <span
                  data-testid="overview-status-saving"
                  className="text-xs text-deep-charcoal/60"
                >
                  saving…
                </span>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span data-testid="overview-status-value">{status}</span>
              <button
                type="button"
                data-testid="overview-status-edit-button"
                aria-label="Edit status"
                onClick={startEditingStatus}
                className="rounded p-1 text-deep-charcoal/60 hover:bg-deep-charcoal/5 hover:text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
              >
                <svg
                  aria-hidden="true"
                  width="14"
                  height="14"
                  viewBox="0 0 14 14"
                  fill="none"
                >
                  <path
                    d="M9.5 2.5L11.5 4.5L4.5 11.5H2.5V9.5L9.5 2.5Z"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
          )}
          {statusSaveError !== null && (
            <p
              role="alert"
              data-testid="overview-status-error"
              className="mt-1 text-xs text-ironwake"
            >
              {statusSaveError}
            </p>
          )}
        </FieldRow>
        <FieldRow label="Version" testId="overview-field-version">
          <span className="text-deep-charcoal/60">—</span>
        </FieldRow>
        <FieldRow label="API Health" testId="overview-field-health">
          <span
            data-testid={`overview-health-${health.kind}`}
            title={health.kind === 'unavailable' ? health.reason : undefined}
            className={
              health.kind === 'ok'
                ? 'inline-flex items-center rounded-full bg-seafoam/15 px-2.5 py-0.5 text-xs text-seafoam'
                : 'text-deep-charcoal/60'
            }
          >
            {healthLabel}
          </span>
        </FieldRow>
        <FieldRow label="Contact Email" testId="overview-field-email">
          <span className="text-deep-charcoal/60">—</span>
        </FieldRow>
        <FieldRow label="Deploy Date" testId="overview-field-deploy-date">
          {formatDate(product.createdAt)}
        </FieldRow>
        <FieldRow label="Last Active" testId="overview-field-last-active">
          {formatDate(product.lastActiveAt)}
        </FieldRow>
        <FieldRow label="MRR" testId="overview-field-mrr">
          {formatDollars(product.mrrCents)}
        </FieldRow>
        <FieldRow label="Tenant" testId="overview-field-tenant">
          {product.tenantName}
        </FieldRow>
      </dl>
      {/* aria-live region for screen readers — announces save status / errors. */}
      <div
        id={ariaLiveId}
        role="status"
        aria-live="polite"
        className="sr-only"
      >
        {savingStatus
          ? 'Saving status…'
          : statusSaveError !== null
            ? `Status save failed: ${statusSaveError}`
            : ''}
      </div>
    </div>
  );
}
