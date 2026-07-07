// Authorized by HUB-1438 (E-CMP-WAVE4b S5) — Add Policy modal.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { apiClient } from '../../lib/api';
import { useToastStore } from '../../stores/toastStore';
import type { CreatePolicyPayload, PolicyRow, PolicyType } from './types';

export interface AddPolicyModalProps {
  onClose: () => void;
  onCreated: (row: PolicyRow) => void;
}

const POLICY_TYPES: Array<{ v: PolicyType; label: string }> = [
  { v: 'security', label: 'Security' },
  { v: 'privacy', label: 'Privacy' },
  { v: 'acceptable_use', label: 'Acceptable use' },
  { v: 'incident_response', label: 'Incident response' },
  { v: 'other', label: 'Other' },
];

const initialDraft: CreatePolicyPayload = { policy_name: '', policy_type: 'security', version: '' };

export function AddPolicyModal({ onClose, onCreated }: AddPolicyModalProps): React.ReactElement {
  const [draft, setDraft] = useState<CreatePolicyPayload>(initialDraft);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof CreatePolicyPayload, string>>>({});
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const addToast = useToastStore((s) => s.addToast);

  useEffect(() => { firstFieldRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const set = <K extends keyof CreatePolicyPayload>(k: K, v: CreatePolicyPayload[K]): void => {
    setDraft((d) => ({ ...d, [k]: v }));
  };

  const validate = (): boolean => {
    const e: typeof errors = {};
    if (!draft.policy_name.trim()) e.policy_name = 'Required';
    if (!draft.version.trim()) e.version = 'Required';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const onSubmit = async (evt: FormEvent<HTMLFormElement>): Promise<void> => {
    evt.preventDefault();
    if (!validate()) return;
    setSubmitting(true);
    try {
      const payload: CreatePolicyPayload = {
        policy_name: draft.policy_name.trim(),
        policy_type: draft.policy_type,
        version: draft.version.trim(),
        effective_date: draft.effective_date || undefined,
        review_due_date: draft.review_due_date || undefined,
        owner_id: draft.owner_id?.trim() || undefined,
        document_url: draft.document_url?.trim() || undefined,
      };
      const row = await apiClient.post<PolicyRow>('/api/v1/admin/grc/policies', payload);
      addToast({ variant: 'success', message: 'Policy added.' });
      onCreated(row);
    } catch (err) {
      addToast({ variant: 'error', message: err instanceof Error ? err.message : 'Failed to add policy.' });
    } finally {
      setSubmitting(false);
    }
  };

  const fc = 'rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass';
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="add-policy-heading" data-testid="add-policy-modal"
      className="fixed inset-0 z-40 flex items-center justify-center bg-deep-charcoal/40 p-4">
      <div className="w-full max-w-lg rounded-md bg-sailcloth p-4 shadow-lg">
        <h2 id="add-policy-heading" className="mb-3 font-heading text-lg text-primary-navy">Add policy</h2>
        <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Policy name
            <input ref={firstFieldRef} data-testid="add-policy-name" type="text" value={draft.policy_name}
              onChange={(e) => set('policy_name', e.target.value)} aria-required="true"
              aria-invalid={errors.policy_name ? true : undefined} className={fc} />
            {errors.policy_name && <span className="text-xs text-error-crimson">{errors.policy_name}</span>}
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
              Type
              <select data-testid="add-policy-type" value={draft.policy_type}
                onChange={(e) => set('policy_type', e.target.value as PolicyType)} className={fc}>
                {POLICY_TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
              Version
              <input data-testid="add-policy-version" type="text" value={draft.version}
                onChange={(e) => set('version', e.target.value)} placeholder="v1.0"
                aria-required="true" aria-invalid={errors.version ? true : undefined} className={fc} />
              {errors.version && <span className="text-xs text-error-crimson">{errors.version}</span>}
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
              Effective date
              <input data-testid="add-policy-effective" type="date" value={draft.effective_date ?? ''}
                onChange={(e) => set('effective_date', e.target.value)} className={fc} />
            </label>
            <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
              Review due
              <input data-testid="add-policy-review-due" type="date" value={draft.review_due_date ?? ''}
                onChange={(e) => set('review_due_date', e.target.value)} className={fc} />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Document URL (optional)
            <input data-testid="add-policy-doc-url" type="url" value={draft.document_url ?? ''}
              onChange={(e) => set('document_url', e.target.value)} className={fc} />
          </label>
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" data-testid="add-policy-cancel" onClick={onClose}
              className="rounded border border-deep-charcoal/20 px-3 py-1.5 text-sm font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass">Cancel</button>
            <button type="submit" disabled={submitting} data-testid="add-policy-submit"
              className="rounded bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 focus:outline-none focus:ring-2 focus:ring-accent-brass disabled:opacity-50">
              {submitting ? 'Adding…' : 'Add policy'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default AddPolicyModal;
