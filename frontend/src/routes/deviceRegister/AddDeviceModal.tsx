// Authorized by HUB-1396 (E-CMP-WAVE4 S3) — Add Device modal. Controlled form matching
// the HUB-1385 POST /api/v1/admin/grc/devices contract. Story text called out fields
// that the shipped HUB-1384 schema doesn't have (device_type, assigned_user_id,
// os_version, mdm_enrolled); this modal collects the actual schema fields instead —
// see HUB-1396 close-out for the reconciliation.
import { useState, useEffect, useRef, type FormEvent } from 'react';
import { apiClient } from '../../lib/api';
import { useToastStore } from '../../stores/toastStore';
import type { CreateDevicePayload, DeviceRow } from './types';

export interface AddDeviceModalProps {
  onClose: () => void;
  onCreated: (row: DeviceRow) => void;
}

const initialDraft: CreateDevicePayload = {
  product_id: '',
  device_name: '',
  owner_name: '',
  owner_email: '',
};

export function AddDeviceModal({ onClose, onCreated }: AddDeviceModalProps): React.ReactElement {
  const [draft, setDraft] = useState<CreateDevicePayload>(initialDraft);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof CreateDevicePayload, string>>>({});
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const addToast = useToastStore((s) => s.addToast);

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const set = <K extends keyof CreateDevicePayload>(key: K, value: string): void => {
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const validate = (): boolean => {
    const e: typeof errors = {};
    if (!draft.product_id.trim()) e.product_id = 'Required';
    if (!draft.device_name.trim()) e.device_name = 'Required';
    if (!draft.owner_name.trim()) e.owner_name = 'Required';
    if (!draft.owner_email.trim()) e.owner_email = 'Required';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const onSubmit = async (evt: FormEvent<HTMLFormElement>): Promise<void> => {
    evt.preventDefault();
    if (!validate()) return;
    setSubmitting(true);
    try {
      const payload: CreateDevicePayload = {
        product_id: draft.product_id.trim(),
        device_name: draft.device_name.trim(),
        owner_name: draft.owner_name.trim(),
        owner_email: draft.owner_email.trim(),
        model: draft.model?.trim() || undefined,
        serial_number: draft.serial_number?.trim() || undefined,
        enrollment_date: draft.enrollment_date?.trim() || undefined,
      };
      const row = await apiClient.post<DeviceRow>('/api/v1/admin/grc/devices', payload);
      addToast({ variant: 'success', message: 'Device added.' });
      onCreated(row);
    } catch (err) {
      addToast({
        variant: 'error',
        message: err instanceof Error ? err.message : 'Failed to add device.',
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
      aria-labelledby="add-device-heading"
      data-testid="add-device-modal"
      className="fixed inset-0 z-40 flex items-center justify-center bg-deep-charcoal/40 p-4"
    >
      <div className="w-full max-w-lg rounded-md bg-sailcloth p-4 shadow-lg">
        <h2 id="add-device-heading" className="mb-3 font-heading text-lg text-primary-navy">
          Add device
        </h2>
        <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Product key
            <input
              ref={firstFieldRef}
              data-testid="add-device-product-id"
              type="text"
              value={draft.product_id}
              onChange={(e) => set('product_id', e.target.value)}
              aria-required="true"
              aria-invalid={errors.product_id ? true : undefined}
              className={fieldClass}
              placeholder="e.g. hub, contenthelm"
            />
            {errors.product_id && (
              <span className="text-xs text-error-crimson">{errors.product_id}</span>
            )}
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Device name
            <input
              data-testid="add-device-name"
              type="text"
              value={draft.device_name}
              onChange={(e) => set('device_name', e.target.value)}
              aria-required="true"
              aria-invalid={errors.device_name ? true : undefined}
              className={fieldClass}
            />
            {errors.device_name && (
              <span className="text-xs text-error-crimson">{errors.device_name}</span>
            )}
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Owner name
            <input
              data-testid="add-device-owner-name"
              type="text"
              value={draft.owner_name}
              onChange={(e) => set('owner_name', e.target.value)}
              aria-required="true"
              aria-invalid={errors.owner_name ? true : undefined}
              className={fieldClass}
            />
            {errors.owner_name && (
              <span className="text-xs text-error-crimson">{errors.owner_name}</span>
            )}
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Owner email
            <input
              data-testid="add-device-owner-email"
              type="email"
              value={draft.owner_email}
              onChange={(e) => set('owner_email', e.target.value)}
              aria-required="true"
              aria-invalid={errors.owner_email ? true : undefined}
              className={fieldClass}
            />
            {errors.owner_email && (
              <span className="text-xs text-error-crimson">{errors.owner_email}</span>
            )}
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Model (optional)
            <input
              data-testid="add-device-model"
              type="text"
              value={draft.model ?? ''}
              onChange={(e) => set('model', e.target.value)}
              className={fieldClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Serial number (optional)
            <input
              data-testid="add-device-serial"
              type="text"
              value={draft.serial_number ?? ''}
              onChange={(e) => set('serial_number', e.target.value)}
              className={fieldClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Enrollment date (optional)
            <input
              data-testid="add-device-enrollment-date"
              type="date"
              value={draft.enrollment_date ?? ''}
              onChange={(e) => set('enrollment_date', e.target.value)}
              className={fieldClass}
            />
          </label>
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              data-testid="add-device-cancel"
              onClick={onClose}
              className="rounded border border-deep-charcoal/20 px-3 py-1.5 text-sm font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              data-testid="add-device-submit"
              className="rounded bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 focus:outline-none focus:ring-2 focus:ring-accent-brass disabled:opacity-50"
            >
              {submitting ? 'Adding…' : 'Add device'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default AddDeviceModal;
