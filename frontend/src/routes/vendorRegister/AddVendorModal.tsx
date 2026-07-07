// Authorized by HUB-1436 (E-CMP-WAVE4b S3) — Add Vendor modal.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { apiClient } from '../../lib/api';
import { useToastStore } from '../../stores/toastStore';
import type {
  CreateVendorPayload, VendorDataAccessLevel, VendorRiskLevel, VendorRow, VendorType,
} from './types';

export interface AddVendorModalProps {
  onClose: () => void;
  onCreated: (row: VendorRow) => void;
}

const VENDOR_TYPES: Array<{ v: VendorType; label: string }> = [
  { v: 'saas', label: 'SaaS' },
  { v: 'infrastructure', label: 'Infrastructure' },
  { v: 'professional_services', label: 'Professional services' },
  { v: 'other', label: 'Other' },
];
const DATA_ACCESS_LEVELS: VendorDataAccessLevel[] = ['none', 'limited', 'full'];
const RISK_LEVELS: VendorRiskLevel[] = ['low', 'medium', 'high', 'critical'];

const initialDraft: CreateVendorPayload = { vendor_name: '', vendor_type: 'saas' };

export function AddVendorModal({ onClose, onCreated }: AddVendorModalProps): React.ReactElement {
  const [draft, setDraft] = useState<CreateVendorPayload>(initialDraft);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof CreateVendorPayload, string>>>({});
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const addToast = useToastStore((s) => s.addToast);

  useEffect(() => { firstFieldRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const set = <K extends keyof CreateVendorPayload>(k: K, v: CreateVendorPayload[K]): void => {
    setDraft((d) => ({ ...d, [k]: v }));
  };

  const validate = (): boolean => {
    const e: typeof errors = {};
    if (!draft.vendor_name.trim()) e.vendor_name = 'Required';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const onSubmit = async (evt: FormEvent<HTMLFormElement>): Promise<void> => {
    evt.preventDefault();
    if (!validate()) return;
    setSubmitting(true);
    try {
      const payload: CreateVendorPayload = {
        vendor_name: draft.vendor_name.trim(),
        vendor_type: draft.vendor_type,
        website: draft.website?.trim() || undefined,
        contract_start_date: draft.contract_start_date || undefined,
        contract_end_date: draft.contract_end_date || undefined,
        data_access_level: draft.data_access_level,
        risk_level: draft.risk_level,
      };
      const row = await apiClient.post<VendorRow>('/api/v1/admin/grc/vendors', payload);
      addToast({ variant: 'success', message: 'Vendor added.' });
      onCreated(row);
    } catch (err) {
      addToast({ variant: 'error', message: err instanceof Error ? err.message : 'Failed to add vendor.' });
    } finally {
      setSubmitting(false);
    }
  };

  const fc = 'rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass';
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-vendor-heading"
      data-testid="add-vendor-modal"
      className="fixed inset-0 z-40 flex items-center justify-center bg-deep-charcoal/40 p-4"
    >
      <div className="w-full max-w-lg rounded-md bg-sailcloth p-4 shadow-lg">
        <h2 id="add-vendor-heading" className="mb-3 font-heading text-lg text-primary-navy">Add vendor</h2>
        <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Vendor name
            <input
              ref={firstFieldRef} data-testid="add-vendor-name" type="text" value={draft.vendor_name}
              onChange={(e) => set('vendor_name', e.target.value)} aria-required="true"
              aria-invalid={errors.vendor_name ? true : undefined} className={fc}
            />
            {errors.vendor_name && <span className="text-xs text-error-crimson">{errors.vendor_name}</span>}
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Vendor type
            <select
              data-testid="add-vendor-type" value={draft.vendor_type}
              onChange={(e) => set('vendor_type', e.target.value as VendorType)} className={fc}
            >
              {VENDOR_TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Website (optional)
            <input data-testid="add-vendor-website" type="url" value={draft.website ?? ''}
              onChange={(e) => set('website', e.target.value)} className={fc}
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
              Data access level
              <select
                data-testid="add-vendor-data-access" value={draft.data_access_level ?? ''}
                onChange={(e) => set('data_access_level', e.target.value ? (e.target.value as VendorDataAccessLevel) : undefined)}
                className={fc}
              >
                <option value="">—</option>
                {DATA_ACCESS_LEVELS.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
              Risk level
              <select
                data-testid="add-vendor-risk" value={draft.risk_level ?? ''}
                onChange={(e) => set('risk_level', e.target.value ? (e.target.value as VendorRiskLevel) : undefined)}
                className={fc}
              >
                <option value="">—</option>
                {RISK_LEVELS.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
          </div>
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" data-testid="add-vendor-cancel" onClick={onClose}
              className="rounded border border-deep-charcoal/20 px-3 py-1.5 text-sm font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass">Cancel</button>
            <button type="submit" disabled={submitting} data-testid="add-vendor-submit"
              className="rounded bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 focus:outline-none focus:ring-2 focus:ring-accent-brass disabled:opacity-50">
              {submitting ? 'Adding…' : 'Add vendor'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default AddVendorModal;
