// Authorized by HUB-1385 (E-CMP-WAVE4 S2, HUB-870) — deadline computation + control
// key mapping for GRC-Lite Wave 4 registers. Pure logic extracted from the route
// handlers so the correctness of the sla_deadline / revocation_deadline formulas
// can be asserted directly (per the story's explicit unit-test call-outs).

import type { DeviceComplianceType } from '../compliance/grcTypes.js';

export const ONBOARDING_SLA_DAYS = 7;
export const OFFBOARDING_REVOCATION_HOURS = 24;

/**
 * Given an ISO date string (YYYY-MM-DD), returns the SLA deadline date
 * (hire_date + 7 calendar days) as another YYYY-MM-DD string. Rejects
 * unparseable input by throwing — callers should validate before invoking.
 */
export function hireDatePlusSlaDays(hireDate: string): string {
  const d = new Date(`${hireDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid hire_date: ${hireDate}`);
  d.setUTCDate(d.getUTCDate() + ONBOARDING_SLA_DAYS);
  return d.toISOString().slice(0, 10);
}

/**
 * Given an ISO date string (YYYY-MM-DD) for last_day, returns the revocation
 * deadline as a full ISO timestamp (last_day + 24 hours, evaluated at UTC midnight
 * so the "24 h after last day" is consistent regardless of local time).
 */
export function lastDayPlusRevocationHours(lastDay: string): string {
  const d = new Date(`${lastDay}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid last_day: ${lastDay}`);
  d.setUTCHours(d.getUTCHours() + OFFBOARDING_REVOCATION_HOURS);
  return d.toISOString();
}

/**
 * Maps a device compliance_type value (mdm_enrollment / disk_encryption / screen_lock)
 * to the compliance_controls.control_id string seeded by migration 067. The signal
 * emission service uses this to resolve which control the attestation counts toward.
 */
const CONTROL_KEY_BY_COMPLIANCE_TYPE: Record<DeviceComplianceType, string> = {
  mdm_enrollment: 'device-mdm-compliance',
  disk_encryption: 'device-disk-encryption',
  screen_lock: 'device-screen-lock',
};

export function controlKeyForComplianceType(t: DeviceComplianceType): string {
  return CONTROL_KEY_BY_COMPLIANCE_TYPE[t];
}

export const CONTROL_KEY_HR_ONBOARDING = 'hr-onboarding-sla';
export const CONTROL_KEY_HR_OFFBOARDING = 'hr-offboarding-24h';
