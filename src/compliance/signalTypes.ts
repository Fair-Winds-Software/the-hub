// Authorized by HUB-1384 (E-CMP-WAVE4 S1, HUB-870) — GRC-Lite Wave 4 signal type
// registry. Each signal type declared here is a value operators can INSERT into
// `compliance_signal_evidence.signal_type` and that the human control evaluator
// (HUB-1354 human escalation scheduler) recognizes when scanning for control
// completion events.
//
// The three constants below are the ones HUB-1385 CRUD API will emit on
// register-completion events; the human evaluator's EXISTS query keys on these
// exact strings, so they are the boundary between the CRUD API and the evaluator.
// Future waves that add register types append their signal types here.

export const SIGNAL_DEVICE_COMPLIANCE_ATTESTED = 'device_compliance_attested' as const;
export const SIGNAL_HR_ONBOARDING_COMPLETED = 'hr_onboarding_completed' as const;
export const SIGNAL_HR_OFFBOARDING_COMPLETED = 'hr_offboarding_completed' as const;

export const GRC_WAVE4_SIGNAL_TYPES = [
  SIGNAL_DEVICE_COMPLIANCE_ATTESTED,
  SIGNAL_HR_ONBOARDING_COMPLETED,
  SIGNAL_HR_OFFBOARDING_COMPLETED,
] as const;

export type GrcWave4SignalType = (typeof GRC_WAVE4_SIGNAL_TYPES)[number];

// HUB-1422 (E-CMP-WAVE4b S1, HUB-871) — GRC-Lite Wave 4b signal types for the
// vendor/cloud/policy register triad. Same registry pattern as Wave 4 above;
// separated only to keep the "which epic added this" traceability clean.
export const SIGNAL_VENDOR_RISK_ASSESSED = 'vendor_risk_assessed' as const;
export const SIGNAL_CLOUD_SECURITY_ATTESTED = 'cloud_security_attested' as const;
export const SIGNAL_POLICY_ACKNOWLEDGED = 'policy_acknowledged' as const;

export const GRC_WAVE4B_SIGNAL_TYPES = [
  SIGNAL_VENDOR_RISK_ASSESSED,
  SIGNAL_CLOUD_SECURITY_ATTESTED,
  SIGNAL_POLICY_ACKNOWLEDGED,
] as const;

export type GrcWave4bSignalType = (typeof GRC_WAVE4B_SIGNAL_TYPES)[number];
