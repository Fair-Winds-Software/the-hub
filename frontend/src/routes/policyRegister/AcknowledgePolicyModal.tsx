// Authorized by HUB-1438 (E-CMP-WAVE4b S5) — Acknowledge Policy modal. Any authenticated
// user may acknowledge (models employee self-service, per HUB-1423 AC 13). Emits
// `policy_acknowledged` compliance signal on successful POST.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { apiClient } from '../../lib/api';
import { useToastStore } from '../../stores/toastStore';
import type { AcknowledgePolicyPayload, PolicyRow } from './types';

export interface AcknowledgePolicyModalProps {
  policy: PolicyRow;
  onClose: () => void;
  onAcknowledged: () => void;
}

export function AcknowledgePolicyModal({
  policy, onClose, onAcknowledged,
}: AcknowledgePolicyModalProps): React.ReactElement {
  const [employeeId, setEmployeeId] = useState('');
  const [employeeName, setEmployeeName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const addToast = useToastStore((s) => s.addToast);

  useEffect(() => { firstFieldRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onSubmit = async (evt: FormEvent<HTMLFormElement>): Promise<void> => {
    evt.preventDefault();
    if (!employeeId.trim() || !employeeName.trim()) {
      setError('Employee ID and name are required.');
      return;
    }
    setError(null); setSubmitting(true);
    try {
      const payload: AcknowledgePolicyPayload = {
        employee_id: employeeId.trim(),
        employee_name: employeeName.trim(),
        policy_version: policy.version,
      };
      await apiClient.post(`/api/v1/admin/grc/policies/${policy.id}/acknowledge`, payload);
      addToast({ variant: 'success', message: 'Policy acknowledged.' });
      onAcknowledged();
    } catch (err) {
      addToast({ variant: 'error', message: err instanceof Error ? err.message : 'Failed to acknowledge policy.' });
    } finally {
      setSubmitting(false);
    }
  };

  const fc = 'rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass';
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="ack-policy-heading" data-testid="ack-policy-modal"
      className="fixed inset-0 z-40 flex items-center justify-center bg-deep-charcoal/40 p-4">
      <div className="w-full max-w-lg rounded-md bg-sailcloth p-4 shadow-lg">
        <h2 id="ack-policy-heading" className="mb-3 font-heading text-lg text-primary-navy">
          Acknowledge {policy.policy_name} ({policy.version})
        </h2>
        <p className="mb-3 text-xs font-body text-deep-charcoal/70">
          Recording an acknowledgment on behalf of an employee. This action emits a
          compliance signal into the audit trail.
        </p>
        <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Employee ID
            <input ref={firstFieldRef} data-testid="ack-employee-id" type="text" value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)} aria-required="true"
              aria-invalid={error ? true : undefined} className={fc} />
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Employee name
            <input data-testid="ack-employee-name" type="text" value={employeeName}
              onChange={(e) => setEmployeeName(e.target.value)} aria-required="true"
              aria-invalid={error ? true : undefined} className={fc} />
            {error && <span className="text-xs text-error-crimson">{error}</span>}
          </label>
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" data-testid="ack-cancel" onClick={onClose}
              className="rounded border border-deep-charcoal/20 px-3 py-1.5 text-sm font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass">Cancel</button>
            <button type="submit" disabled={submitting} data-testid="ack-submit"
              className="rounded bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 focus:outline-none focus:ring-2 focus:ring-accent-brass disabled:opacity-50">
              {submitting ? 'Recording…' : 'Acknowledge'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default AcknowledgePolicyModal;
