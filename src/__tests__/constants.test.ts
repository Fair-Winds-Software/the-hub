// Authorized by HUB-50 — unit tests for HUB service constants
import { describe, it, expect } from 'vitest';
import { MAVERICK_LAUNCH_TENANT_ID } from '../constants.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('MAVERICK_LAUNCH_TENANT_ID', () => {
  it('is a non-empty string', () => {
    expect(typeof MAVERICK_LAUNCH_TENANT_ID).toBe('string');
    expect(MAVERICK_LAUNCH_TENANT_ID.length).toBeGreaterThan(0);
  });

  it('matches UUID format', () => {
    expect(MAVERICK_LAUNCH_TENANT_ID).toMatch(UUID_REGEX);
  });

  it('is the expected well-known value', () => {
    expect(MAVERICK_LAUNCH_TENANT_ID).toBe('00000000-0000-0000-0000-000000000001');
  });
});
