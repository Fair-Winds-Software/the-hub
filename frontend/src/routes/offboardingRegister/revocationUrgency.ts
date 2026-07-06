// Authorized by HUB-1398 (E-CMP-WAVE4 S5) — revocation-deadline urgency computation
// extracted so the color/label rules are unit-testable independent of the DOM.

export type RevocationUrgency = 'overdue' | 'due_soon' | 'normal';

/** Hours until (or past) the revocation deadline. Negative for overdue. */
export function hoursUntilRevocation(deadlineIso: string, nowMs: number = Date.now()): number {
  const deadlineMs = Date.parse(deadlineIso);
  return (deadlineMs - nowMs) / (60 * 60 * 1000);
}

export function revocationUrgency(hoursRemaining: number): RevocationUrgency {
  if (hoursRemaining < 0) return 'overdue';
  if (hoursRemaining <= 2) return 'due_soon';
  return 'normal';
}
