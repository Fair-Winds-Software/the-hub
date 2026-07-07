// Authorized by HUB-1437 (E-CMP-WAVE4b S4) — Add Cloud Account modal.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { apiClient } from '../../lib/api';
import { useToastStore } from '../../stores/toastStore';
import type { CloudEnvironment, CloudProvider, CloudRow, CreateCloudPayload } from './types';

export interface AddCloudModalProps {
  onClose: () => void;
  onCreated: (row: CloudRow) => void;
}

const PROVIDERS: CloudProvider[] = ['aws', 'gcp', 'azure', 'other'];
const ENVIRONMENTS: CloudEnvironment[] = ['production', 'staging', 'development'];

const initialDraft: CreateCloudPayload = { account_name: '', provider: 'aws' };

export function AddCloudModal({ onClose, onCreated }: AddCloudModalProps): React.ReactElement {
  const [draft, setDraft] = useState<CreateCloudPayload>(initialDraft);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof CreateCloudPayload, string>>>({});
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const addToast = useToastStore((s) => s.addToast);

  useEffect(() => { firstFieldRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const set = <K extends keyof CreateCloudPayload>(k: K, v: CreateCloudPayload[K]): void => {
    setDraft((d) => ({ ...d, [k]: v }));
  };

  const validate = (): boolean => {
    const e: typeof errors = {};
    if (!draft.account_name.trim()) e.account_name = 'Required';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const onSubmit = async (evt: FormEvent<HTMLFormElement>): Promise<void> => {
    evt.preventDefault();
    if (!validate()) return;
    setSubmitting(true);
    try {
      const payload: CreateCloudPayload = {
        account_name: draft.account_name.trim(),
        provider: draft.provider,
        account_id: draft.account_id?.trim() || undefined,
        environment: draft.environment,
        service_type: draft.service_type?.trim() || undefined,
        owner_id: draft.owner_id?.trim() || undefined,
      };
      const row = await apiClient.post<CloudRow>('/api/v1/admin/grc/cloud', payload);
      addToast({ variant: 'success', message: 'Cloud account added.' });
      onCreated(row);
    } catch (err) {
      addToast({ variant: 'error', message: err instanceof Error ? err.message : 'Failed to add cloud account.' });
    } finally {
      setSubmitting(false);
    }
  };

  const fc = 'rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass';
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="add-cloud-heading" data-testid="add-cloud-modal"
      className="fixed inset-0 z-40 flex items-center justify-center bg-deep-charcoal/40 p-4">
      <div className="w-full max-w-lg rounded-md bg-sailcloth p-4 shadow-lg">
        <h2 id="add-cloud-heading" className="mb-3 font-heading text-lg text-primary-navy">Add cloud account</h2>
        <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Account name
            <input ref={firstFieldRef} data-testid="add-cloud-name" type="text" value={draft.account_name}
              onChange={(e) => set('account_name', e.target.value)} aria-required="true"
              aria-invalid={errors.account_name ? true : undefined} className={fc} />
            {errors.account_name && <span className="text-xs text-error-crimson">{errors.account_name}</span>}
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
              Provider
              <select data-testid="add-cloud-provider" value={draft.provider}
                onChange={(e) => set('provider', e.target.value as CloudProvider)} className={fc}>
                {PROVIDERS.map((p) => <option key={p} value={p}>{p.toUpperCase()}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
              Environment
              <select data-testid="add-cloud-environment" value={draft.environment ?? ''}
                onChange={(e) => set('environment', e.target.value ? (e.target.value as CloudEnvironment) : undefined)} className={fc}>
                <option value="">—</option>
                {ENVIRONMENTS.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
          </div>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Provider account ID (optional)
            <input data-testid="add-cloud-account-id" type="text" value={draft.account_id ?? ''}
              onChange={(e) => set('account_id', e.target.value)} className={fc} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
              Service type
              <input data-testid="add-cloud-service-type" type="text" value={draft.service_type ?? ''}
                onChange={(e) => set('service_type', e.target.value)} className={fc} />
            </label>
            <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
              Owner (operator id)
              <input data-testid="add-cloud-owner" type="text" value={draft.owner_id ?? ''}
                onChange={(e) => set('owner_id', e.target.value)} className={fc} />
            </label>
          </div>
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" data-testid="add-cloud-cancel" onClick={onClose}
              className="rounded border border-deep-charcoal/20 px-3 py-1.5 text-sm font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass">Cancel</button>
            <button type="submit" disabled={submitting} data-testid="add-cloud-submit"
              className="rounded bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 focus:outline-none focus:ring-2 focus:ring-accent-brass disabled:opacity-50">
              {submitting ? 'Adding…' : 'Add account'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default AddCloudModal;
