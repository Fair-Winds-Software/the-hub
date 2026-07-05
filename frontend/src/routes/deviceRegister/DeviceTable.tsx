// Authorized by HUB-1396 (E-CMP-WAVE4 S3) — Device inventory table with status badge +
// per-row actions (Attest, Decommission). Actions are shown only when isAdmin=true so
// non-admin operators see the same table in read-only mode (AC 9).
//
// last_attested_at + last_attestation_status columns from the story text render as `—`
// pending a HUB-1385 GET-response extension that JOINs latest device_compliance_records;
// out-of-scope for this story, tracked in the close-out comment.
import type { DeviceRow } from './types';

export interface DeviceTableProps {
  rows: DeviceRow[];
  isAdmin: boolean;
  onAttest: (row: DeviceRow) => void;
  onDecommission: (row: DeviceRow) => void;
}

function StatusPill({ status }: { status: DeviceRow['status'] }): React.ReactElement {
  const classes =
    status === 'active'
      ? 'bg-success-forest/15 text-success-forest'
      : 'bg-deep-charcoal/10 text-deep-charcoal/70';
  return (
    <span
      data-testid={`status-pill-${status}`}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-body ${classes}`}
    >
      {status === 'active' ? 'Active' : 'Decommissioned'}
    </span>
  );
}

export function DeviceTable({
  rows,
  isAdmin,
  onAttest,
  onDecommission,
}: DeviceTableProps): React.ReactElement {
  if (rows.length === 0) {
    return (
      <p
        data-testid="device-table-empty"
        role="status"
        className="rounded border border-dashed border-deep-charcoal/30 p-6 text-center text-sm font-body text-deep-charcoal/70"
      >
        No devices to show.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded border border-deep-charcoal/20">
      <table
        data-testid="device-table"
        className="min-w-full divide-y divide-deep-charcoal/10 text-sm"
      >
        <thead className="bg-deep-charcoal/5">
          <tr>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">Device</th>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">Owner</th>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">Model</th>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">Serial</th>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">Enrolled</th>
            <th scope="col" className="px-3 py-2 text-left font-heading text-primary-navy">Last attested</th>
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
            <tr key={row.id} data-testid={`device-row-${row.id}`} className="bg-white">
              <td className="px-3 py-2 font-body text-primary-navy">
                <div className="font-medium">{row.device_name}</div>
                <div className="text-xs text-deep-charcoal/60">{row.product_id}</div>
              </td>
              <td className="px-3 py-2 font-body text-deep-charcoal">
                <div>{row.owner_name}</div>
                <div className="text-xs text-deep-charcoal/60">{row.owner_email}</div>
              </td>
              <td className="px-3 py-2 font-body text-deep-charcoal">{row.model ?? '—'}</td>
              <td className="px-3 py-2 font-body text-deep-charcoal">{row.serial_number ?? '—'}</td>
              <td className="px-3 py-2 font-body text-deep-charcoal">{row.enrollment_date ?? '—'}</td>
              <td className="px-3 py-2 font-body text-deep-charcoal/50" data-testid="last-attested-placeholder">
                —
              </td>
              <td className="px-3 py-2"><StatusPill status={row.status} /></td>
              {isAdmin && (
                <td className="px-3 py-2 text-right">
                  {row.status === 'active' ? (
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => onAttest(row)}
                        aria-label={`Attest ${row.device_name}`}
                        data-testid={`attest-btn-${row.id}`}
                        className="rounded border border-primary-navy px-2 py-1 text-xs font-body text-primary-navy hover:bg-primary-navy/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
                      >
                        Attest
                      </button>
                      <button
                        type="button"
                        onClick={() => onDecommission(row)}
                        aria-label={`Decommission ${row.device_name}`}
                        data-testid={`decommission-btn-${row.id}`}
                        className="rounded border border-error-crimson/40 px-2 py-1 text-xs font-body text-error-crimson hover:bg-error-crimson/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
                      >
                        Decommission
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

export default DeviceTable;
