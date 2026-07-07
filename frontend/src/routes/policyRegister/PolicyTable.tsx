// Authorized by HUB-1438 (E-CMP-WAVE4b S5) — Policy register table.
// Acknowledge button is shown for BOTH admin and non-admin (AC 13 of HUB-1423 —
// policy acknowledgment is employee self-service). Only Add Policy is admin-gated.
import type { PolicyRow } from './types';

export interface PolicyTableProps {
  rows: PolicyRow[];
  isAdmin: boolean;
  onAcknowledge: (row: PolicyRow) => void;
}

function StatusPill({ status }: { status: PolicyRow['status'] }): React.ReactElement {
  const classes = status === 'active'
    ? 'bg-success-forest/15 text-success-forest'
    : 'bg-deep-charcoal/10 text-deep-charcoal/70';
  return (
    <span data-testid={`policy-status-pill-${status}`}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-body ${classes}`}>
      {status === 'active' ? 'Active' : 'Archived'}
    </span>
  );
}

export function PolicyTable({ rows, isAdmin, onAcknowledge }: PolicyTableProps): React.ReactElement {
  if (rows.length === 0) {
    return (
      <p data-testid="policy-table-empty" role="status"
        className="rounded border border-dashed border-deep-charcoal/30 p-6 text-center text-sm font-body text-deep-charcoal/70">
        No policies to show.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded border border-deep-charcoal/20">
      <table data-testid="policy-table" className="min-w-full divide-y divide-deep-charcoal/10 text-sm">
        <thead className="bg-deep-charcoal/5">
          <tr>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">Policy</th>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">Type</th>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">Version</th>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">Effective</th>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">Next review</th>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">Status</th>
            <th scope="col" className="px-3 py-2 text-right font-heading text-primary-navy">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-deep-charcoal/5">
          {rows.map((row) => (
            <tr key={row.id} data-testid={`policy-row-${row.id}`} className="bg-white">
              <td className="px-3 py-2 font-body text-primary-navy">
                <div className="font-medium">{row.policy_name}</div>
                {row.document_url && (
                  <a href={row.document_url} target="_blank" rel="noopener noreferrer"
                    className="text-xs text-primary-navy/80 underline">document</a>
                )}
              </td>
              <td className="px-3 py-2 font-body text-deep-charcoal">{row.policy_type.replace(/_/g, ' ')}</td>
              <td className="px-3 py-2 font-body text-deep-charcoal">{row.version}</td>
              <td className="px-3 py-2 font-body text-deep-charcoal">{row.effective_date ?? '—'}</td>
              <td className="px-3 py-2 font-body text-deep-charcoal">{row.review_due_date ?? '—'}</td>
              <td className="px-3 py-2"><StatusPill status={row.status} /></td>
              <td className="px-3 py-2 text-right">
                {isAdmin && row.status === 'active' ? (
                  <button type="button" onClick={() => onAcknowledge(row)}
                    aria-label={`Acknowledge ${row.policy_name}`}
                    data-testid={`policy-ack-btn-${row.id}`}
                    className="rounded border border-primary-navy px-2 py-1 text-xs font-body text-primary-navy hover:bg-primary-navy/5 focus:outline-none focus:ring-2 focus:ring-accent-brass">
                    Acknowledge
                  </button>
                ) : <span className="text-xs text-deep-charcoal/50">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default PolicyTable;
