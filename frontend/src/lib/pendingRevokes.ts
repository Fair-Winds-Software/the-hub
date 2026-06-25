// Authorized by HUB-1579 — retry-on-reconnect queue for refresh-token revocation.
// R1 D-HUB-SCOPE-028 + D-HUB-SCOPE-050: on logout, if the BE /logout call fails, enqueue
// the refresh token here so the next app bootstrap can drain it. sessionStorage scope
// (tab-scoped, cleared on tab close) — same effective lifecycle as the in-memory Zustand
// session store, so no expansion of the at-rest threat surface.
//
// Single key: 'hub.pendingRevokes'. Stored shape: { refreshToken: string; queuedAt: string }[]
// (queuedAt = ISO timestamp for debugging / future TTL pruning).

const STORAGE_KEY = 'hub.pendingRevokes';

export interface PendingRevoke {
  refreshToken: string;
  queuedAt: string;
}

function safeStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    // SecurityError in some browsers when storage is disabled — degrade silently.
    return null;
  }
}

function readQueue(): PendingRevoke[] {
  const storage = safeStorage();
  if (!storage) return [];
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is PendingRevoke =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as PendingRevoke).refreshToken === 'string' &&
        typeof (entry as PendingRevoke).queuedAt === 'string',
    );
  } catch {
    // Corrupted JSON — discard and start fresh rather than crashing the app shell.
    storage.removeItem(STORAGE_KEY);
    return [];
  }
}

function writeQueue(queue: PendingRevoke[]): void {
  const storage = safeStorage();
  if (!storage) return;
  if (queue.length === 0) {
    storage.removeItem(STORAGE_KEY);
    return;
  }
  storage.setItem(STORAGE_KEY, JSON.stringify(queue));
}

export function enqueueRevoke(refreshToken: string): void {
  const queue = readQueue();
  queue.push({ refreshToken, queuedAt: new Date().toISOString() });
  writeQueue(queue);
}

export function getPendingRevokes(): readonly PendingRevoke[] {
  return readQueue();
}

export function clearPendingRevokes(): void {
  const storage = safeStorage();
  if (!storage) return;
  storage.removeItem(STORAGE_KEY);
}

/**
 * Drain queue best-effort. For each entry, call `revoke(refreshToken)`. Resolved entries
 * are removed; rejected entries remain queued for the next bootstrap. Single pass — does
 * NOT retry within the same drain to avoid burning CPU on persistent BE outages.
 */
export async function drainPendingRevokes(
  revoke: (refreshToken: string) => Promise<unknown>,
): Promise<{ drained: number; remaining: number }> {
  const queue = readQueue();
  if (queue.length === 0) return { drained: 0, remaining: 0 };

  const remaining: PendingRevoke[] = [];
  let drained = 0;
  for (const entry of queue) {
    try {
      await revoke(entry.refreshToken);
      drained++;
    } catch {
      remaining.push(entry);
    }
  }
  writeQueue(remaining);
  return { drained, remaining: remaining.length };
}
