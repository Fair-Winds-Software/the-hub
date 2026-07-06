// Authorized by HUB-1397 (E-CMP-WAVE4 S4) — HR onboarding table. SLA-urgency coloring
// per AC 2 (overdue=red, 0-3 days=amber, >3 days=default). Actions column omitted
// for non-admin per AC 8.
import type { OnboardingRow } from './types';
import { daysUntilSla, slaUrgency, type SlaUrgency } from './slaDeadline';

export interface OnboardingTableProps {
  rows: OnboardingRow[];
  isAdmin: boolean;
  onComplete: (row: OnboardingRow) => void;
  now?: number;
}

function StatusPill({ status }: { status: OnboardingRow['status'] }): React.ReactElement {
  const classes =
    status === 'completed'
      ? 'bg-success-forest/15 text-success-forest'
      : status === 'overdue'
      ? 'bg-error-crimson/15 text-error-crimson'
      : 'bg-accent-brass/15 text-accent-brass';
  const label =
    status === 'completed' ? 'Complete'
    : status === 'overdue' ? 'Overdue'
    : status === 'in_progress' ? 'In progress'
    : 'Pending';
  return (
    <span
      data-testid={`onb-status-pill-${status}`}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-body ${classes}`}
    >
      {label}
    </span>
  );
}

function SlaCell({ deadline, now }: { deadline: string; now: number }): React.ReactElement {
  const days = daysUntilSla(deadline, now);
  const urgency: SlaUrgency = slaUrgency(days);
  const cls =
    urgency === 'overdue'
      ? 'text-error-crimson font-medium'
      : urgency === 'due_soon'
      ? 'text-accent-brass font-medium'
      : 'text-deep-charcoal';
  const text =
    urgency === 'overdue'
      ? `Overdue by ${Math.abs(days)} ${Math.abs(days) === 1 ? 'day' : 'days'}`
      : `${days} ${days === 1 ? 'day' : 'days'} left`;
  return (
    <span data-testid={`onb-sla-${urgency}`} className={cls}>
      {text}
    </span>
  );
}

export function OnboardingTable({
  rows,
  isAdmin,
  onComplete,
  now,
}: OnboardingTableProps): React.ReactElement {
  const nowMs = now ?? Date.now();
  if (rows.length === 0) {
    return (
      <p
        data-testid="onb-table-empty"
        role="status"
        className="rounded border border-dashed border-deep-charcoal/30 p-6 text-center text-sm font-body text-deep-charcoal/70"
      >
        No onboarding records to show.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded border border-deep-charcoal/20">
      <table
        data-testid="onb-table"
        className="min-w-full divide-y divide-deep-charcoal/10 text-sm"
      >
        <thead className="bg-deep-charcoal/5">
          <tr>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">Employee</th>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">Role</th>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">Hire date</th>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">SLA deadline</th>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">Completed</th>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">Status</th>
            {isAdmin && (
              <th scope="col" className="px-3 py-2 text-right font-heading text-primary-navy">
                Actions
              </th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-deep-charcoal/5">
          {rows.map((row) => (
            <tr key={row.id} data-testid={`onb-row-${row.id}`} className="bg-white">
              <td className="px-3 py-2 font-body text-primary-navy">
                <div className="font-medium">{row.employee_name}</div>
                <div className="text-xs text-deep-charcoal/60">{row.employee_email}</div>
              </td>
              <td className="px-3 py-2 font-body text-deep-charcoal">{row.role}</td>
              <td className="px-3 py-2 font-body text-deep-charcoal">{row.hire_date}</td>
              <td className="px-3 py-2 font-body">
                <div>{row.sla_deadline}</div>
                <div className="text-xs">
                  {row.completed_at ? (
                    <span className="text-deep-charcoal/60">—</span>
                  ) : (
                    <SlaCell deadline={row.sla_deadline} now={nowMs} />
                  )}
                </div>
              </td>
              <td className="px-3 py-2 font-body text-deep-charcoal">
                {row.completed_at ? row.completed_at.slice(0, 10) : '—'}
              </td>
              <td className="px-3 py-2"><StatusPill status={row.status} /></td>
              {isAdmin && (
                <td className="px-3 py-2 text-right">
                  {row.completed_at === null ? (
                    <button
                      type="button"
                      onClick={() => onComplete(row)}
                      aria-label={`Mark ${row.employee_name} onboarding complete`}
                      data-testid={`onb-complete-btn-${row.id}`}
                      className="rounded border border-primary-navy px-2 py-1 text-xs font-body text-primary-navy hover:bg-primary-navy/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
                    >
                      Mark complete
                    </button>
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

export default OnboardingTable;
