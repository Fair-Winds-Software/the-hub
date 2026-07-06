// Authorized by HUB-1398 (E-CMP-WAVE4 S5) — Add Offboarding modal. Same schema-field
// reconciliation as the onboarding modal (product_id + employee_name + employee_email +
// role + last_day; revocation_deadline computed BE-side per HUB-1385).
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { apiClient } from '../../lib/api';
import { useToastStore } from '../../stores/toastStore';
import type { CreateOffboardingPayload, OffboardingRow } from './types';

export interface AddOffboardingModalProps {
  onClose: () => void;
  onCreated: (row: OffboardingRow) => void;
}

const initialDraft: CreateOffboardingPayload = {
  product_id: '',
  employee_name: '',
  employee_email: '',
  role: '',
  last_day: '',
};

export function AddOffboardingModal({ onClose, onCreated }: AddOffboardingModalProps): React.ReactElement {
  const [draft, setDraft] = useState<CreateOffboardingPayload>(initialDraft);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof CreateOffboardingPayload, string>>>({});
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const addToast = useToastStore((s) => s.addToast);

  useEffect(() => { firstFieldRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const set = <K extends keyof CreateOffboardingPayload>(k: K, v: string): void => {
    setDraft((d) => ({ ...d, [k]: v }));
  };

  const validate = (): boolean => {
    const e: typeof errors = {};
    if (!draft.product_id.trim()) e.product_id = 'Required';
    if (!draft.employee_name.trim()) e.employee_name = 'Required';
    if (!draft.employee_email.trim()) e.employee_email = 'Required';
    if (!draft.role.trim()) e.role = 'Required';
    if (!draft.last_day.trim()) e.last_day = 'Required';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const onSubmit = async (evt: FormEvent<HTMLFormElement>): Promise<void> => {
    evt.preventDefault();
    if (!validate()) return;
    setSubmitting(true);
    try {
      const row = await apiClient.post<OffboardingRow>('/api/v1/admin/grc/offboarding', {
        product_id: draft.product_id.trim(),
        employee_name: draft.employee_name.trim(),
        employee_email: draft.employee_email.trim(),
        role: draft.role.trim(),
        last_day: draft.last_day,
      });
      addToast({ variant: 'success', message: 'Offboarding record created.' });
      onCreated(row);
    } catch (err) {
      addToast({
        variant: 'error',
        message: err instanceof Error ? err.message : 'Failed to add offboarding record.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const fieldClass =
    'rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-off-heading"
      data-testid="add-off-modal"
      className="fixed inset-0 z-40 flex items-center justify-center bg-deep-charcoal/40 p-4"
    >
      <div className="w-full max-w-lg rounded-md bg-sailcloth p-4 shadow-lg">
        <h2 id="add-off-heading" className="mb-3 font-heading text-lg text-primary-navy">
          Add offboarding record
        </h2>
        <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Product key
            <input
              ref={firstFieldRef}
              data-testid="add-off-product-id"
              type="text"
              value={draft.product_id}
              onChange={(e) => set('product_id', e.target.value)}
              aria-required="true"
              aria-invalid={errors.product_id ? true : undefined}
              className={fieldClass}
              placeholder="e.g. hub, contenthelm"
            />
            {errors.product_id && <span className="text-xs text-error-crimson">{errors.product_id}</span>}
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Employee name
            <input
              data-testid="add-off-employee-name"
              type="text"
              value={draft.employee_name}
              onChange={(e) => set('employee_name', e.target.value)}
              aria-required="true"
              aria-invalid={errors.employee_name ? true : undefined}
              className={fieldClass}
            />
            {errors.employee_name && <span className="text-xs text-error-crimson">{errors.employee_name}</span>}
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Employee email
            <input
              data-testid="add-off-employee-email"
              type="email"
              value={draft.employee_email}
              onChange={(e) => set('employee_email', e.target.value)}
              aria-required="true"
              aria-invalid={errors.employee_email ? true : undefined}
              className={fieldClass}
            />
            {errors.employee_email && <span className="text-xs text-error-crimson">{errors.employee_email}</span>}
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Role
            <input
              data-testid="add-off-role"
              type="text"
              value={draft.role}
              onChange={(e) => set('role', e.target.value)}
              aria-required="true"
              aria-invalid={errors.role ? true : undefined}
              className={fieldClass}
            />
            {errors.role && <span className="text-xs text-error-crimson">{errors.role}</span>}
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Last day
            <input
              data-testid="add-off-last-day"
              type="date"
              value={draft.last_day}
              onChange={(e) => set('last_day', e.target.value)}
              aria-required="true"
              aria-invalid={errors.last_day ? true : undefined}
              className={fieldClass}
            />
            {errors.last_day && <span className="text-xs text-error-crimson">{errors.last_day}</span>}
          </label>
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              data-testid="add-off-cancel"
              onClick={onClose}
              className="rounded border border-deep-charcoal/20 px-3 py-1.5 text-sm font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              data-testid="add-off-submit"
              className="rounded bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 focus:outline-none focus:ring-2 focus:ring-accent-brass disabled:opacity-50"
            >
              {submitting ? 'Adding…' : 'Add record'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default AddOffboardingModal;
