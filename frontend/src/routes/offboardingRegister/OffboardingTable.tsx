// Authorized by HUB-1398 (E-CMP-WAVE4 S5) — HR offboarding table with inline
// 3-checkbox checklist per row. Checkboxes are read-only for non-admin (AC 7).
// Revocation-deadline urgency coloring per AC 2 (past=red, ≤2h=amber, else default).
// The auto-complete-on-all-three transition is BE-driven — this table just reflects
// the boolean fields as returned by the API; the page handles the PUT + refetch.
import type { OffboardingRow } from './types';
import { hoursUntilRevocation, revocationUrgency, type RevocationUrgency } from './revocationUrgency';

export interface OffboardingTableProps {
  rows: OffboardingRow[];
  isAdmin: boolean;
  onChecklistToggle: (row: OffboardingRow, field: ChecklistField, value: boolean) => void;
  now?: number;
}

export type ChecklistField = 'device_returned' | 'accounts_disabled' | 'tokens_revoked';

const CHECKLIST_FIELDS: Array<{ key: ChecklistField; label: string }> = [
  { key: 'device_returned', label: 'Equipment returned' },
  { key: 'accounts_disabled', label: 'Accounts deprovisioned' },
  { key: 'tokens_revoked', label: 'Tokens revoked' },
];

function StatusPill({ status }: { status: OffboardingRow['status'] }): React.ReactElement {
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
      data-testid={`off-status-pill-${status}`}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-body ${classes}`}
    >
      {label}
    </span>
  );
}

function DeadlineCell({ deadline, now }: { deadline: string; now: number }): React.ReactElement {
  const hours = hoursUntilRevocation(deadline, now);
  const urgency: RevocationUrgency = revocationUrgency(hours);
  const cls =
    urgency === 'overdue'
      ? 'text-error-crimson font-medium'
      : urgency === 'due_soon'
      ? 'text-accent-brass font-medium'
      : 'text-deep-charcoal';
  const label =
    urgency === 'overdue'
      ? 'Overdue'
      : urgency === 'due_soon'
      ? 'Due soon'
      : `${Math.round(hours)}h left`;
  return (
    <span data-testid={`off-urgency-${urgency}`} className={cls}>
      {label}
    </span>
  );
}

function ChecklistBar({ row }: { row: OffboardingRow }): React.ReactElement {
  const checked = [row.device_returned, row.accounts_disabled, row.tokens_revoked].filter(Boolean).length;
  return (
    <span data-testid={`off-checklist-progress-${row.id}`} className="text-xs text-deep-charcoal">
      {checked}/3
    </span>
  );
}

export function OffboardingTable({
  rows,
  isAdmin,
  onChecklistToggle,
  now,
}: OffboardingTableProps): React.ReactElement {
  const nowMs = now ?? Date.now();
  if (rows.length === 0) {
    return (
      <p
        data-testid="off-table-empty"
        role="status"
        className="rounded border border-dashed border-deep-charcoal/30 p-6 text-center text-sm font-body text-deep-charcoal/70"
      >
        No offboarding records to show.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded border border-deep-charcoal/20">
      <table
        data-testid="off-table"
        className="min-w-full divide-y divide-deep-charcoal/10 text-sm"
      >
        <thead className="bg-deep-charcoal/5">
          <tr>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">Employee</th>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">Role</th>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">Last day</th>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">Revocation deadline</th>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">Checklist</th>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">Progress</th>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-deep-charcoal/5">
          {rows.map((row) => (
            <tr key={row.id} data-testid={`off-row-${row.id}`} className="bg-white">
              <td className="px-3 py-2 font-body text-primary-navy">
                <div className="font-medium">{row.employee_name}</div>
                <div className="text-xs text-deep-charcoal/60">{row.employee_email}</div>
              </td>
              <td className="px-3 py-2 font-body text-deep-charcoal">{row.role}</td>
              <td className="px-3 py-2 font-body text-deep-charcoal">{row.last_day}</td>
              <td className="px-3 py-2 font-body">
                <div>{row.revocation_deadline.slice(0, 16).replace('T', ' ')}</div>
                <div className="text-xs">
                  {row.completed_at ? (
                    <span className="text-deep-charcoal/60">Completed</span>
                  ) : (
                    <DeadlineCell deadline={row.revocation_deadline} now={nowMs} />
                  )}
                </div>
              </td>
              <td className="px-3 py-2">
                <div className="flex flex-col gap-1">
                  {CHECKLIST_FIELDS.map((f) => (
                    <label
                      key={f.key}
                      className="flex items-center gap-2 text-xs font-body text-deep-charcoal"
                    >
                      <input
                        type="checkbox"
                        checked={row[f.key]}
                        disabled={!isAdmin || row.completed_at !== null}
                        onChange={(e) => onChecklistToggle(row, f.key, e.target.checked)}
                        data-testid={`off-check-${f.key}-${row.id}`}
                        aria-label={`${f.label} for ${row.employee_name}`}
                        className="h-4 w-4 rounded border-deep-charcoal/30 text-primary-navy focus:ring-2 focus:ring-accent-brass"
                      />
                      {f.label}
                    </label>
                  ))}
                </div>
              </td>
              <td className="px-3 py-2"><ChecklistBar row={row} /></td>
              <td className="px-3 py-2"><StatusPill status={row.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default OffboardingTable;
