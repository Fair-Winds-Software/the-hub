// Authorized by HUB-1397 (E-CMP-WAVE4 S4) — SLA-deadline urgency computation extracted
// so the styling rules are unit-testable independent of DOM rendering.

export type SlaUrgency = 'overdue' | 'due_soon' | 'normal';

/**
 * Days until (or past) the SLA deadline, ceiling-rounded so an "in 6 hours" delta
 * still reads as 1 day, matching the story's "0-3 days remaining" language.
 * Returns negative for overdue.
 */
export function daysUntilSla(slaDeadlineIso: string, nowMs: number = Date.now()): number {
  // Treat the sla_deadline (YYYY-MM-DD) as UTC midnight so the day-count is
  // stable across operator timezones.
  const deadlineMs = Date.parse(`${slaDeadlineIso}T00:00:00Z`);
  return Math.ceil((deadlineMs - nowMs) / 86400000);
}

export function slaUrgency(daysRemaining: number): SlaUrgency {
  if (daysRemaining < 0) return 'overdue';
  if (daysRemaining <= 3) return 'due_soon';
  return 'normal';
}
