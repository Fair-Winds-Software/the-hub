// Authorized by HUB-1436 (E-CMP-WAVE4b S3) — Vendor register table with risk-level
// badge + per-row Assess / Archive actions. Actions column omitted for non-admin.
import type { VendorRow, VendorRiskLevel } from './types';

export interface VendorTableProps {
  rows: VendorRow[];
  isAdmin: boolean;
  onAssess: (row: VendorRow) => void;
  onArchive: (row: VendorRow) => void;
}

function StatusPill({ status }: { status: VendorRow['status'] }): React.ReactElement {
  const classes =
    status === 'active'
      ? 'bg-success-forest/15 text-success-forest'
      : 'bg-deep-charcoal/10 text-deep-charcoal/70';
  return (
    <span
      data-testid={`vendor-status-pill-${status}`}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-body ${classes}`}
    >
      {status === 'active' ? 'Active' : 'Archived'}
    </span>
  );
}

function RiskBadge({ risk }: { risk: VendorRiskLevel | null }): React.ReactElement {
  if (risk === null) return <span className="text-xs text-deep-charcoal/50">—</span>;
  const classes: Record<VendorRiskLevel, string> = {
    low: 'bg-success-forest/15 text-success-forest',
    medium: 'bg-accent-brass/15 text-accent-brass',
    high: 'bg-error-crimson/15 text-error-crimson',
    critical: 'bg-error-crimson/30 text-error-crimson font-semibold',
  };
  return (
    <span
      data-testid={`vendor-risk-${risk}`}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-body ${classes[risk]}`}
    >
      {risk[0]!.toUpperCase() + risk.slice(1)}
    </span>
  );
}

export function VendorTable({ rows, isAdmin, onAssess, onArchive }: VendorTableProps): React.ReactElement {
  if (rows.length === 0) {
    return (
      <p
        data-testid="vendor-table-empty"
        role="status"
        className="rounded border border-dashed border-deep-charcoal/30 p-6 text-center text-sm font-body text-deep-charcoal/70"
      >
        No vendors to show.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded border border-deep-charcoal/20">
      <table data-testid="vendor-table" className="min-w-full divide-y divide-deep-charcoal/10 text-sm">
        <thead className="bg-deep-charcoal/5">
          <tr>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">Vendor</th>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">Type</th>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">Data access</th>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">Risk</th>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">Next review</th>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">Status</th>
            {isAdmin && <th scope="col" className="px-3 py-2 text-right font-heading text-primary-navy">Actions</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-deep-charcoal/5">
          {rows.map((row) => (
            <tr key={row.id} data-testid={`vendor-row-${row.id}`} className="bg-white">
              <td className="px-3 py-2 font-body text-primary-navy">
                <div className="font-medium">{row.vendor_name}</div>
                {row.website && <div className="text-xs text-deep-charcoal/60">{row.website}</div>}
              </td>
              <td className="px-3 py-2 font-body text-deep-charcoal">{row.vendor_type.replace(/_/g, ' ')}</td>
              <td className="px-3 py-2 font-body text-deep-charcoal">{row.data_access_level ?? '—'}</td>
              <td className="px-3 py-2"><RiskBadge risk={row.risk_level} /></td>
              <td className="px-3 py-2 font-body text-deep-charcoal">{row.next_review_due ?? '—'}</td>
              <td className="px-3 py-2"><StatusPill status={row.status} /></td>
              {isAdmin && (
                <td className="px-3 py-2 text-right">
                  {row.status === 'active' ? (
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => onAssess(row)}
                        aria-label={`Assess ${row.vendor_name}`}
                        data-testid={`vendor-assess-btn-${row.id}`}
                        className="rounded border border-primary-navy px-2 py-1 text-xs font-body text-primary-navy hover:bg-primary-navy/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
                      >
                        Assess
                      </button>
                      <button
                        type="button"
                        onClick={() => onArchive(row)}
                        aria-label={`Archive ${row.vendor_name}`}
                        data-testid={`vendor-archive-btn-${row.id}`}
                        className="rounded border border-error-crimson/40 px-2 py-1 text-xs font-body text-error-crimson hover:bg-error-crimson/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
                      >
                        Archive
                      </button>
                    </div>
                  ) : (
                    <span className="text-xs text-deep-charcoal/50">—</span>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default VendorTable;
