// Authorized by HUB-1436 (E-CMP-WAVE4b S3) — Assess Vendor modal. POST /:id/assessment
// emits a `vendor_risk_assessed` compliance signal per HUB-1423 AC 5.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { apiClient } from '../../lib/api';
import { useToastStore } from '../../stores/toastStore';
import type { AssessVendorPayload, VendorRow } from './types';

export interface AssessVendorModalProps {
  vendor: VendorRow;
  onClose: () => void;
  onAssessed: () => void;
}

export function AssessVendorModal({ vendor, onClose, onAssessed }: AssessVendorModalProps): React.ReactElement {
  const [riskScore, setRiskScore] = useState<number>(50);
  const [assessedBy, setAssessedBy] = useState('');
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
    if (!assessedBy.trim()) { setError('Assessed by is required.'); return; }
    setError(null); setSubmitting(true);
    try {
      const payload: AssessVendorPayload = {
        risk_score: riskScore,
        assessed_by: assessedBy.trim(),
        findings: findings.trim() || undefined,
      };
      await apiClient.post(`/api/v1/admin/grc/vendors/${vendor.id}/assessment`, payload);
      addToast({ variant: 'success', message: 'Vendor assessment recorded.' });
      onAssessed();
    } catch (err) {
      addToast({ variant: 'error', message: err instanceof Error ? err.message : 'Failed to record assessment.' });
    } finally {
      setSubmitting(false);
    }
  };

  const fc = 'rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass';
  return (
    <div
      role="dialog" aria-modal="true" aria-labelledby="assess-vendor-heading" data-testid="assess-vendor-modal"
      className="fixed inset-0 z-40 flex items-center justify-center bg-deep-charcoal/40 p-4"
    >
      <div className="w-full max-w-lg rounded-md bg-sailcloth p-4 shadow-lg">
        <h2 id="assess-vendor-heading" className="mb-3 font-heading text-lg text-primary-navy">
          Assess {vendor.vendor_name}
        </h2>
        <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Risk score (0–100)
            <input
              ref={firstFieldRef} data-testid="assess-vendor-risk-score" type="number" min={0} max={100}
              value={riskScore} onChange={(e) => setRiskScore(parseInt(e.target.value, 10))}
              aria-required="true" className={fc}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Assessed by
            <input
              data-testid="assess-vendor-assessed-by" type="text" value={assessedBy}
              onChange={(e) => setAssessedBy(e.target.value)} aria-required="true"
              aria-invalid={error ? true : undefined} className={fc}
            />
            {error && <span className="text-xs text-error-crimson">{error}</span>}
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Findings (optional)
            <textarea
              data-testid="assess-vendor-findings" rows={3} value={findings}
              onChange={(e) => setFindings(e.target.value)} className={fc}
            />
          </label>
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" data-testid="assess-vendor-cancel" onClick={onClose}
              className="rounded border border-deep-charcoal/20 px-3 py-1.5 text-sm font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass">Cancel</button>
            <button type="submit" disabled={submitting} data-testid="assess-vendor-submit"
              className="rounded bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 focus:outline-none focus:ring-2 focus:ring-accent-brass disabled:opacity-50">
              {submitting ? 'Recording…' : 'Record assessment'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default AssessVendorModal;
