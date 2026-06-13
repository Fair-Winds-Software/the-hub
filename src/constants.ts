// Authorized by HUB-50 — well-known UUIDs; single source of truth for HUB service constants

// Fixed UUID for the Maverick Launch internal umbrella tenant.
// This value is seeded at migration time — never change it after first deploy.
// All downstream code must reference this constant; no inline string literals.
export const MAVERICK_LAUNCH_TENANT_ID = '00000000-0000-0000-0000-000000000001';
