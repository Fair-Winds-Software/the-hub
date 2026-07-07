// Authorized by HUB-1437 (E-CMP-WAVE4b S4) — Attest Cloud Account modal.
// Selecting `fail` or `partial` surfaces an inline "No compliance signal emitted" note
// before submit (matches HUB-1423 AC 14 + HUB-1396 UX for non-compliant device attest).
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { apiClient } from '../../lib/api';
import { useToastStore } from '../../stores/toastStore';
import type { AttestCloudPayload, CloudAttestationStatus, CloudRow } from './types';

export interface AttestCloudModalProps {
  account: CloudRow;
  onClose: () => void;
  onAttested: () => void;
}

const STATUSES: Array<{ v: CloudAttestationStatus; label: string }> = [
  { v: 'pass', label: 'Pass' },
  { v: 'fail', label: 'Fail' },
  { v: 'partial', label: 'Partial' },
];

export function AttestCloudModal({ account, onClose, onAttested }: AttestCloudModalProps): React.ReactElement {
  const [attestationType, setAttestationType] = useState('');
  const [status, setStatus] = useState<CloudAttestationStatus>('pass');
  const [attestedBy, setAttestedBy] = useState('');
  const [findings, setFindings] = useState('');
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
    if (!attestationType.trim() || !attestedBy.trim()) {
      setError('Attestation type and Attested by are required.');
      return;
    }
    setError(null); setSubmitting(true);
    try {
      const payload: AttestCloudPayload = {
        attestation_type: attestationType.trim(),
        status,
        attested_by: attestedBy.trim(),
        findings: findings.trim() || undefined,
      };
      await apiClient.post(`/api/v1/admin/grc/cloud/${account.id}/attestation`, payload);
      addToast({ variant: 'success', message: 'Attestation recorded.' });
      onAttested();
    } catch (err) {
      addToast({ variant: 'error', message: err instanceof Error ? err.message : 'Failed to record attestation.' });
    } finally {
      setSubmitting(false);
    }
  };

  const fc = 'rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass';
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="attest-cloud-heading" data-testid="attest-cloud-modal"
      className="fixed inset-0 z-40 flex items-center justify-center bg-deep-charcoal/40 p-4">
      <div className="w-full max-w-lg rounded-md bg-sailcloth p-4 shadow-lg">
        <h2 id="attest-cloud-heading" className="mb-3 font-heading text-lg text-primary-navy">
          Attest {account.account_name}
        </h2>
        <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Attestation type
            <input ref={firstFieldRef} data-testid="attest-cloud-type" type="text" value={attestationType}
              onChange={(e) => setAttestationType(e.target.value)} placeholder="e.g. mfa_enforcement"
              aria-required="true" className={fc} />
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Status
            <select data-testid="attest-cloud-status" value={status}
              onChange={(e) => setStatus(e.target.value as CloudAttestationStatus)}
              aria-required="true" className={fc}>
              {STATUSES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
            </select>
          </label>
          {status !== 'pass' && (
            <p data-testid="attest-cloud-nonpass-note" role="note"
              className="rounded border border-accent-brass/40 bg-accent-brass/5 p-2 text-xs font-body text-deep-charcoal/80">
              No compliance signal emitted ({status}).
            </p>
          )}
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Attested by
            <input data-testid="attest-cloud-attested-by" type="text" value={attestedBy}
              onChange={(e) => setAttestedBy(e.target.value)} aria-required="true"
              aria-invalid={error ? true : undefined} className={fc} />
            {error && <span className="text-xs text-error-crimson">{error}</span>}
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Findings (optional)
            <textarea data-testid="attest-cloud-findings" rows={3} value={findings}
              onChange={(e) => setFindings(e.target.value)} className={fc} />
          </label>
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" data-testid="attest-cloud-cancel" onClick={onClose}
              className="rounded border border-deep-charcoal/20 px-3 py-1.5 text-sm font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass">Cancel</button>
            <button type="submit" disabled={submitting} data-testid="attest-cloud-submit"
              className="rounded bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 focus:outline-none focus:ring-2 focus:ring-accent-brass disabled:opacity-50">
              {submitting ? 'Recording…' : 'Record attestation'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default AttestCloudModal;
