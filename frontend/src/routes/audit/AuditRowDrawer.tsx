// Authorized by HUB-1615 (E-FE-12 S5) — row-detail drawer. Consumes HUB-1611 <SideDrawer>
// (Sheet pattern, size 'md'). Receives `row` from Audit page state (S4 onRowClick handler
// sets it). Renders formatted fields + pretty-printed JSON detail.
//
// Spec deviations (documented):
// 1. "Open in new tab" link points to /console/audit?eventId=<id>. The eventId deep-link
//    handling is HUB-1616 S6 work; the link is rendered here so the markup is stable, but
//    the URL doesn't yet pre-open the drawer on landing. Documented; S6 closes the loop.
// 2. Copy-to-clipboard fallback: when navigator.clipboard.writeText is unavailable
//    (older browsers / non-secure context), the catch path emits a warning toast instead
//    of silently failing.
import { useCallback, type ReactNode } from 'react';
import { SideDrawer } from '../../components/SideDrawer';
import { useToastStore } from '../../stores/toastStore';
import type { AuditRow } from './AuditFilters';

export interface AuditRowDrawerProps {
  /** The currently-selected audit row, or null when no drawer is open. */
  row: AuditRow | null;
  /** Called when the drawer requests close (Escape, close button, URL back). */
  onClose: () => void;
}

function formatDetailJson(row: AuditRow): string {
  // Compose a single payload from the row's detail-bearing fields. Omit nulls to keep
  // the preview compact.
  const detail: Record<string, unknown> = {
    notes: row.notes,
    before_value: row.before_value,
    after_value: row.after_value,
  };
  // JSON.stringify with 2-space indent (spec).
  return JSON.stringify(detail, null, 2);
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  // ISO + " UTC" suffix mirrors the SOC-2-friendly format from the spec example
  // ("2026-06-21 14:32:11 UTC").
  return `${d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')} UTC`;
}

function HeaderRow({ row }: { row: AuditRow }): ReactNode {
  return (
    <span className="text-sm text-deep-charcoal/70">
      {row.action} · {row.entity_type} · {formatTimestamp(row.created_at)}
    </span>
  );
}

interface FieldProps {
  label: string;
  children: ReactNode;
}

function Field({ label, children }: FieldProps): ReactNode {
  return (
    <div className="flex flex-col gap-1">
      <dt className="font-heading text-xs uppercase tracking-wide text-deep-charcoal/60">
        {label}
      </dt>
      <dd className="font-body text-sm text-deep-charcoal break-words">{children}</dd>
    </div>
  );
}

export function AuditRowDrawer({
  row,
  onClose,
}: AuditRowDrawerProps): React.ReactElement {
  const addToast = useToastStore((s) => s.addToast);

  const handleCopyEntityId = useCallback(async () => {
    if (!row) return;
    try {
      if (!navigator.clipboard?.writeText) {
        // Spec deviation #2: surface a warning rather than silently failing.
        addToast({
          variant: 'warning',
          message: 'Clipboard not available in this browser.',
        });
        return;
      }
      await navigator.clipboard.writeText(row.entity_id);
      addToast({ variant: 'success', message: 'Entity ID copied' });
    } catch {
      addToast({
        variant: 'error',
        message: 'Could not copy Entity ID. Try again.',
      });
    }
  }, [row, addToast]);

  return (
    <SideDrawer
      open={row !== null}
      onClose={onClose}
      title={row ? `${row.action} · ${row.entity_type}` : ''}
      size="md"
    >
      {row !== null && (
        <div className="flex flex-col gap-4">
          <HeaderRow row={row} />

          <dl className="grid grid-cols-1 gap-3">
            <Field label="Actor">
              <span data-testid="row-actor">
                {row.operator_id ?? <em className="text-deep-charcoal/60">system</em>}
              </span>
            </Field>
            <Field label="Action">
              <code className="font-mono text-sm">{row.action}</code>
            </Field>
            <Field label="Entity Type">
              <code className="font-mono text-sm">{row.entity_type}</code>
            </Field>
            <Field label="Entity ID">
              <div className="flex items-center gap-2">
                <code
                  className="font-mono text-sm break-all"
                  data-testid="row-entity-id"
                >
                  {row.entity_id}
                </code>
                <button
                  type="button"
                  onClick={handleCopyEntityId}
                  aria-label="Copy Entity ID"
                  className="flex-shrink-0 rounded border border-mist bg-sailcloth px-2 py-1 text-xs font-body text-primary-navy hover:bg-mist focus:outline-none focus:ring-2 focus:ring-primary-brass"
                >
                  Copy
                </button>
              </div>
            </Field>
          </dl>

          <div className="flex flex-col gap-1">
            <h3 className="font-heading text-xs uppercase tracking-wide text-deep-charcoal/60">
              Detail
            </h3>
            <pre
              className="overflow-x-auto rounded border border-mist bg-mist/30 p-3 font-mono text-xs text-deep-charcoal"
              data-testid="row-detail-json"
            >
              {formatDetailJson(row)}
            </pre>
          </div>

          {/* Spec deviation #1 — `eventId` URL handling lands in HUB-1616 S6. The anchor
              renders correctly here so the markup is stable across that change. */}
          <a
            href={`/console/audit?eventId=${encodeURIComponent(row.id)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="self-start text-sm font-body text-primary-navy underline hover:text-primary-brass focus:outline-none focus:ring-2 focus:ring-primary-brass"
            data-testid="row-permalink"
          >
            Open in new tab
          </a>
        </div>
      )}
    </SideDrawer>
  );
}
