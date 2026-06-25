// Authorized by HUB-1579 — pendingRevokes queue primitives.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPendingRevokes,
  drainPendingRevokes,
  enqueueRevoke,
  getPendingRevokes,
} from '../pendingRevokes';

const STORAGE_KEY = 'hub.pendingRevokes';

describe('pendingRevokes (HUB-1579)', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  afterEach(() => {
    window.sessionStorage.clear();
  });

  describe('enqueueRevoke', () => {
    it('appends a new entry with the refresh token and an ISO queuedAt timestamp', () => {
      enqueueRevoke('rt-abc');
      const queue = getPendingRevokes();
      expect(queue).toHaveLength(1);
      expect(queue[0]?.refreshToken).toBe('rt-abc');
      expect(queue[0]?.queuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('appends multiple entries preserving insertion order', () => {
      enqueueRevoke('rt-1');
      enqueueRevoke('rt-2');
      enqueueRevoke('rt-3');
      const queue = getPendingRevokes();
      expect(queue.map((e) => e.refreshToken)).toEqual(['rt-1', 'rt-2', 'rt-3']);
    });

    it('persists to sessionStorage under the canonical key', () => {
      enqueueRevoke('rt-persist');
      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!) as Array<{ refreshToken: string }>;
      expect(parsed[0]?.refreshToken).toBe('rt-persist');
    });
  });

  describe('getPendingRevokes', () => {
    it('returns an empty array when nothing is queued', () => {
      expect(getPendingRevokes()).toEqual([]);
    });

    it('discards corrupted JSON and returns empty', () => {
      window.sessionStorage.setItem(STORAGE_KEY, 'not-json{');
      expect(getPendingRevokes()).toEqual([]);
      // Corrupt value cleared so we do not loop on the corruption.
      expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('filters out malformed entries while preserving valid ones', () => {
      window.sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([
          { refreshToken: 'good', queuedAt: '2026-06-24T00:00:00Z' },
          { refreshToken: 42, queuedAt: 'x' },
          null,
          'string',
        ]),
      );
      const queue = getPendingRevokes();
      expect(queue).toHaveLength(1);
      expect(queue[0]?.refreshToken).toBe('good');
    });
  });

  describe('clearPendingRevokes', () => {
    it('removes the queue from sessionStorage', () => {
      enqueueRevoke('rt-x');
      clearPendingRevokes();
      expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
      expect(getPendingRevokes()).toEqual([]);
    });
  });

  describe('drainPendingRevokes', () => {
    it('returns 0/0 when queue is empty without invoking the revoke fn', async () => {
      const revoke = vi.fn().mockResolvedValue(undefined);
      const result = await drainPendingRevokes(revoke);
      expect(result).toEqual({ drained: 0, remaining: 0 });
      expect(revoke).not.toHaveBeenCalled();
    });

    it('drains all entries when the revoke fn resolves for each', async () => {
      enqueueRevoke('rt-1');
      enqueueRevoke('rt-2');
      const revoke = vi.fn().mockResolvedValue(undefined);

      const result = await drainPendingRevokes(revoke);

      expect(result).toEqual({ drained: 2, remaining: 0 });
      expect(revoke).toHaveBeenCalledTimes(2);
      expect(revoke).toHaveBeenNthCalledWith(1, 'rt-1');
      expect(revoke).toHaveBeenNthCalledWith(2, 'rt-2');
      expect(getPendingRevokes()).toEqual([]);
    });

    it('leaves rejected entries queued and removes resolved ones', async () => {
      enqueueRevoke('rt-ok');
      enqueueRevoke('rt-fail');
      enqueueRevoke('rt-ok-2');
      const revoke = vi.fn(async (token: string) => {
        if (token === 'rt-fail') throw new Error('BE down');
      });

      const result = await drainPendingRevokes(revoke);

      expect(result).toEqual({ drained: 2, remaining: 1 });
      const remaining = getPendingRevokes();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.refreshToken).toBe('rt-fail');
    });

    it('does not retry within the same drain (single pass)', async () => {
      enqueueRevoke('rt-1');
      const revoke = vi.fn().mockRejectedValue(new Error('nope'));
      await drainPendingRevokes(revoke);
      expect(revoke).toHaveBeenCalledTimes(1);
    });
  });
});
