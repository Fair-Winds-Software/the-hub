// Authorized by HUB-1385 (E-CMP-WAVE4 S2) — deadline computation + control mapping.
// Directly proves the story's explicit unit-test call-outs: revocation_deadline
// (last_day + 24h) and sla_deadline (hire_date + 7 days).
import { describe, it, expect } from 'vitest';
import {
  hireDatePlusSlaDays,
  lastDayPlusRevocationHours,
  controlKeyForComplianceType,
  CONTROL_KEY_HR_ONBOARDING,
  CONTROL_KEY_HR_OFFBOARDING,
  ONBOARDING_SLA_DAYS,
  OFFBOARDING_REVOCATION_HOURS,
} from '../grcRegisterService.js';

describe('hireDatePlusSlaDays (AC: sla_deadline = hire_date + 7 days)', () => {
  it('adds exactly ONBOARDING_SLA_DAYS to the hire date', () => {
    expect(ONBOARDING_SLA_DAYS).toBe(7);
    expect(hireDatePlusSlaDays('2026-07-05')).toBe('2026-07-12');
  });

  it('crosses month boundary correctly', () => {
    expect(hireDatePlusSlaDays('2026-07-28')).toBe('2026-08-04');
  });

  it('crosses year boundary correctly', () => {
    expect(hireDatePlusSlaDays('2026-12-30')).toBe('2027-01-06');
  });

  it('throws on unparseable input', () => {
    expect(() => hireDatePlusSlaDays('not-a-date')).toThrow(/invalid hire_date/);
  });
});

describe('lastDayPlusRevocationHours (AC: revocation_deadline = last_day + 24h)', () => {
  it('adds exactly OFFBOARDING_REVOCATION_HOURS from UTC midnight of last_day', () => {
    expect(OFFBOARDING_REVOCATION_HOURS).toBe(24);
    expect(lastDayPlusRevocationHours('2026-07-05')).toBe('2026-07-06T00:00:00.000Z');
  });

  it('handles DST boundary transitions without drift (UTC-based)', () => {
    // 2026-03-08 is a US DST-transition day; the result must still be exactly
    // 24 h later at UTC midnight, not "23h in local time".
    expect(lastDayPlusRevocationHours('2026-03-08')).toBe('2026-03-09T00:00:00.000Z');
  });

  it('throws on unparseable input', () => {
    expect(() => lastDayPlusRevocationHours('nope')).toThrow(/invalid last_day/);
  });
});

describe('controlKeyForComplianceType (device compliance_type → seeded control_id)', () => {
  it('maps each compliance_type to the matching HUB-1384 seeded control_id string', () => {
    expect(controlKeyForComplianceType('mdm_enrollment')).toBe('device-mdm-compliance');
    expect(controlKeyForComplianceType('disk_encryption')).toBe('device-disk-encryption');
    expect(controlKeyForComplianceType('screen_lock')).toBe('device-screen-lock');
  });
});

describe('HR control key constants', () => {
  it('are the seeded control_id strings from migration 067', () => {
    expect(CONTROL_KEY_HR_ONBOARDING).toBe('hr-onboarding-sla');
    expect(CONTROL_KEY_HR_OFFBOARDING).toBe('hr-offboarding-24h');
  });
});
