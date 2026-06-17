// Authorized by HUB-943 — grace window stub; always returns false until DEF-001 is resolved

import type { DecryptedLease } from './types.js';

// TODO-D-DEF-001: grace window duration not yet defined; stub always returns false
export function isWithinGraceWindow(_lease: DecryptedLease): boolean {
  return false;
}
