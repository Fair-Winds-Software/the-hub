// Authorized by HUB-1396 (E-CMP-WAVE4 S3) — Attest Device modal. Matches the HUB-1385
// POST /api/v1/admin/grc/devices/:id/compliance contract. Non-compliant selection surfaces
// an inline "No compliance signal emitted" note before submit (AC 5 of HUB-1396 + AC 13
// of HUB-1385).
import { useState, useEffect, useRef, type FormEvent } from 'react';
import { apiClient } from '../../lib/api';
import { useToastStore } from '../../stores/toastStore';
import type {
  AttestDevicePayload,
  DeviceComplianceStatus,
  DeviceComplianceType,
  DeviceRow,
} from './types';

export interface AttestDeviceModalProps {
  device: DeviceRow;
  onClose: () => void;
  onAttested: () => void;
}

const COMPLIANCE_TYPES: Array<{ value: DeviceComplianceType; label: string }> = [
  { value: 'mdm_enrollment', label: 'MDM enrollment' },
  { value: 'disk_encryption', label: 'Disk encryption' },
  { value: 'screen_lock', label: 'Screen lock policy' },
];

const STATUSES: Array<{ value: DeviceComplianceStatus; label: string }> = [
  { value: 'compliant', label: 'Compliant' },
  { value: 'non_compliant', label: 'Non-compliant' },
  { value: 'pending_verification', label: 'Pending verification' },
];

export function AttestDeviceModal({
  device,
  onClose,
  onAttested,
}: AttestDeviceModalProps): React.ReactElement {
  const [complianceType, setComplianceType] = useState<DeviceComplianceType>('mdm_enrollment');
  const [status, setStatus] = useState<DeviceComplianceStatus>('compliant');
  const [attestedBy, setAttestedBy] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLSelectElement | null>(null);
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

  const onSubmit = async (evt: FormEvent<HTMLFormElement>): Promise<void> => {
    evt.preventDefault();
    if (!attestedBy.trim()) {
      setError('Attested by is required.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const payload: AttestDevicePayload = {
        compliance_type: complianceType,
        status,
        attested_by: attestedBy.trim(),
      };
      await apiClient.post(
        `/api/v1/admin/grc/devices/${device.id}/compliance`,
        payload,
      );
      addToast({ variant: 'success', message: 'Attestation recorded.' });
      onAttested();
    } catch (err) {
      addToast({
        variant: 'error',
        message: err instanceof Error ? err.message : 'Failed to record attestation.',
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
      aria-labelledby="attest-device-heading"
      data-testid="attest-device-modal"
      className="fixed inset-0 z-40 flex items-center justify-center bg-deep-charcoal/40 p-4"
    >
      <div className="w-full max-w-lg rounded-md bg-sailcloth p-4 shadow-lg">
        <h2 id="attest-device-heading" className="mb-3 font-heading text-lg text-primary-navy">
          Attest {device.device_name}
        </h2>
        <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Compliance type
            <select
              ref={firstFieldRef}
              data-testid="attest-compliance-type"
              value={complianceType}
              onChange={(e) => setComplianceType(e.target.value as DeviceComplianceType)}
              aria-required="true"
              className={fieldClass}
            >
              {COMPLIANCE_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Status
            <select
              data-testid="attest-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as DeviceComplianceStatus)}
              aria-required="true"
              className={fieldClass}
            >
              {STATUSES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </label>
          {status === 'non_compliant' && (
            <p
              data-testid="attest-noncompliant-note"
              role="note"
              className="rounded border border-accent-brass/40 bg-accent-brass/5 p-2 text-xs font-body text-deep-charcoal/80"
            >
              No compliance signal emitted (non-compliant).
            </p>
          )}
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Attested by
            <input
              data-testid="attest-attested-by"
              type="text"
              value={attestedBy}
              onChange={(e) => setAttestedBy(e.target.value)}
              aria-required="true"
              aria-invalid={error ? true : undefined}
              className={fieldClass}
            />
            {error && <span className="text-xs text-error-crimson">{error}</span>}
          </label>
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              data-testid="attest-cancel"
              onClick={onClose}
              className="rounded border border-deep-charcoal/20 px-3 py-1.5 text-sm font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              data-testid="attest-submit"
              className="rounded bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 focus:outline-none focus:ring-2 focus:ring-accent-brass disabled:opacity-50"
            >
              {submitting ? 'Recording…' : 'Record attestation'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default AttestDeviceModal;
