// Authorized by HUB-1437 (E-CMP-WAVE4b S4) — Cloud infrastructure register table.
import type { CloudRow } from './types';

export interface CloudTableProps {
  rows: CloudRow[];
  isAdmin: boolean;
  onAttest: (row: CloudRow) => void;
}

function StatusPill({ status }: { status: CloudRow['status'] }): React.ReactElement {
  const classes = status === 'active'
    ? 'bg-success-forest/15 text-success-forest'
    : 'bg-deep-charcoal/10 text-deep-charcoal/70';
  return (
    <span data-testid={`cloud-status-pill-${status}`}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-body ${classes}`}>
      {status === 'active' ? 'Active' : 'Archived'}
    </span>
  );
}

function SecurityScoreBadge({ score }: { score: number | null }): React.ReactElement {
  if (score === null) return <span className="text-xs text-deep-charcoal/50">—</span>;
  const cls = score >= 80
    ? 'text-success-forest font-medium'
    : score >= 50
    ? 'text-accent-brass font-medium'
    : 'text-error-crimson font-medium';
  return <span data-testid="cloud-security-score" className={cls}>{score}</span>;
}

export function CloudTable({ rows, isAdmin, onAttest }: CloudTableProps): React.ReactElement {
  if (rows.length === 0) {
    return (
      <p data-testid="cloud-table-empty" role="status"
        className="rounded border border-dashed border-deep-charcoal/30 p-6 text-center text-sm font-body text-deep-charcoal/70">
        No cloud accounts to show.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded border border-deep-charcoal/20">
      <table data-testid="cloud-table" className="min-w-full divide-y divide-deep-charcoal/10 text-sm">
        <thead className="bg-deep-charcoal/5">
          <tr>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">Account</th>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">Provider</th>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">Environment</th>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">Security score</th>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">Next audit</th>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">Status</th>
            {isAdmin && <th scope="col" className="px-3 py-2 text-right font-heading text-primary-navy">Actions</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-deep-charcoal/5">
          {rows.map((row) => (
            <tr key={row.id} data-testid={`cloud-row-${row.id}`} className="bg-white">
              <td className="px-3 py-2 font-body text-primary-navy">
                <div className="font-medium">{row.account_name}</div>
                {row.account_id && <div className="text-xs text-deep-charcoal/60">{row.account_id}</div>}
              </td>
              <td className="px-3 py-2 font-body text-deep-charcoal uppercase">{row.provider}</td>
              <td className="px-3 py-2 font-body text-deep-charcoal">{row.environment ?? '—'}</td>
              <td className="px-3 py-2"><SecurityScoreBadge score={row.security_score} /></td>
              <td className="px-3 py-2 font-body text-deep-charcoal">{row.next_audit_due ?? '—'}</td>
              <td className="px-3 py-2"><StatusPill status={row.status} /></td>
              {isAdmin && (
                <td className="px-3 py-2 text-right">
                  {row.status === 'active' ? (
                    <button type="button" onClick={() => onAttest(row)}
                      aria-label={`Attest ${row.account_name}`}
                      data-testid={`cloud-attest-btn-${row.id}`}
                      className="rounded border border-primary-navy px-2 py-1 text-xs font-body text-primary-navy hover:bg-primary-navy/5 focus:outline-none focus:ring-2 focus:ring-accent-brass">
                      Attest
                    </button>
                  ) : <span className="text-xs text-deep-charcoal/50">—</span>}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default CloudTable;
