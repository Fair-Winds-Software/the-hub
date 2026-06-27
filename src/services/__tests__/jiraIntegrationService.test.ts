// Authorized by HUB-1593 (E-BE-1 S10, CR-1) — unit tests for jiraIntegrationService covering
// the R1 reason matrix: cache miss → fetch → cache; cache hit → no fetch; 429 / 401 / 5xx;
// product-not-mapped + token-missing short circuits; clearAuthCache + getCacheKey shape.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRedisGet = vi.hoisted(() => vi.fn());
const mockRedisSet = vi.hoisted(() => vi.fn().mockResolvedValue('OK'));
const mockRedisDel = vi.hoisted(() => vi.fn().mockResolvedValue(1));
vi.mock('../../redis/client.js', () => ({
  getRedisClient: () => ({
    get: mockRedisGet,
    set: mockRedisSet,
    del: mockRedisDel,
  }),
  isRedisConnected: () => true,
}));

const mockGetSetting = vi.hoisted(() => vi.fn());
vi.mock('../adminSettings.js', () => ({
  getSetting: mockGetSetting,
}));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  getTicketCounts,
  getCacheKey,
  clearAuthCache,
  type JiraTicketsResponse,
} from '../jiraIntegrationService.js';

const PRODUCT = 'contenthelm';
const PROJECT = 'CH';
const MAPPING = { contenthelm: 'CH', hub: 'HUB', synapz: 'SYNC', launchkit: 'LK' };

function mockFetchOnce(status: number, body?: unknown) {
  const fetchSpy = vi.fn().mockResolvedValueOnce({
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body ?? {}),
  } as Response);
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  return fetchSpy;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JIRA_SERVICE_EMAIL = 'svc@example.com';
  process.env.JIRA_SERVICE_TOKEN = 'tok-abc';
  process.env.JIRA_WORKSPACE_URL = 'https://example.atlassian.net';
  mockGetSetting.mockResolvedValue(MAPPING);
});

describe('jiraIntegrationService (HUB-1593)', () => {
  describe('getCacheKey', () => {
    it('returns the canonical jira:tickets:<productKey> shape', () => {
      expect(getCacheKey('contenthelm')).toBe('jira:tickets:contenthelm');
      expect(getCacheKey('hub')).toBe('jira:tickets:hub');
    });
  });

  describe('token-missing short circuit', () => {
    it('returns token_missing when JIRA_SERVICE_TOKEN is empty', async () => {
      process.env.JIRA_SERVICE_TOKEN = '';
      const result = await getTicketCounts(PRODUCT);
      expect(result).toEqual({ available: false, reason: 'token_missing' });
      // Should not have touched Redis or fetch.
      expect(mockRedisGet).not.toHaveBeenCalled();
    });

    it('returns token_missing when JIRA_SERVICE_EMAIL is empty', async () => {
      process.env.JIRA_SERVICE_EMAIL = '';
      const result = await getTicketCounts(PRODUCT);
      expect(result).toEqual({ available: false, reason: 'token_missing' });
    });
  });

  describe('cache hit short circuit', () => {
    it('returns the cached success response without calling fetch', async () => {
      const cached: JiraTicketsResponse = {
        available: true,
        openCRs: 3,
        openBugs: 5,
        lastSyncedAt: '2026-06-27T00:00:00.000Z',
      };
      mockRedisGet.mockResolvedValueOnce(JSON.stringify(cached));
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      const result = await getTicketCounts(PRODUCT);

      expect(result).toEqual(cached);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mockRedisSet).not.toHaveBeenCalled();
    });

    it('returns cached transient failure stubs', async () => {
      const cached: JiraTicketsResponse = { available: false, reason: 'rate_limited' };
      mockRedisGet.mockResolvedValueOnce(JSON.stringify(cached));

      const result = await getTicketCounts(PRODUCT);
      expect(result).toEqual(cached);
    });
  });

  describe('auth-failure global cache', () => {
    it('short-circuits to auth_failed when the global auth-failure key is set', async () => {
      mockRedisGet
        .mockResolvedValueOnce(null)         // tickets cache miss
        .mockResolvedValueOnce('1');         // auth-failure marker present
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      const result = await getTicketCounts(PRODUCT);
      expect(result).toEqual({ available: false, reason: 'auth_failed' });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('product_not_mapped', () => {
    it('returns product_not_mapped when the product key is absent from the settings map', async () => {
      mockRedisGet.mockResolvedValue(null);
      mockGetSetting.mockResolvedValueOnce({ contenthelm: 'CH' }); // hub not mapped

      const result = await getTicketCounts('hub');
      expect(result).toEqual({ available: false, reason: 'product_not_mapped' });
      // NOT cached — adding the mapping resolves on the very next request.
      expect(mockRedisSet).not.toHaveBeenCalled();
    });

    it('returns product_not_mapped when the settings value is undefined / non-object', async () => {
      mockRedisGet.mockResolvedValue(null);
      mockGetSetting.mockResolvedValueOnce(undefined);

      const result = await getTicketCounts(PRODUCT);
      expect(result).toEqual({ available: false, reason: 'product_not_mapped' });
    });
  });

  describe('Atlassian 200 happy path', () => {
    it('parses the response, counts by type, returns available:true, and caches 900s', async () => {
      mockRedisGet.mockResolvedValue(null);
      const fetchSpy = mockFetchOnce(200, {
        issues: [
          { fields: { issuetype: { name: 'Bug' } } },
          { fields: { issuetype: { name: 'Bug' } } },
          { fields: { issuetype: { name: 'Change Request' } } },
        ],
      });

      const result = await getTicketCounts(PRODUCT);

      expect(result).toMatchObject({ available: true, openCRs: 1, openBugs: 2 });
      if (result.available) {
        expect(typeof result.lastSyncedAt).toBe('string');
      }

      // Assert fetch URL + auth header.
      const [calledUrl, init] = fetchSpy.mock.calls[0]!;
      expect(String(calledUrl)).toContain('https://example.atlassian.net/rest/api/3/search/jql');
      expect(String(calledUrl)).toContain(`project+%3D+%22${PROJECT}%22`);
      expect((init as RequestInit).headers).toMatchObject({
        Authorization: expect.stringMatching(/^Basic /),
      });

      // Cached with success TTL.
      expect(mockRedisSet).toHaveBeenCalledWith(
        getCacheKey(PRODUCT),
        expect.any(String),
        'EX',
        900,
      );
    });

    it('counts zero when the response has no matching issues', async () => {
      mockRedisGet.mockResolvedValue(null);
      mockFetchOnce(200, { issues: [] });

      const result = await getTicketCounts(PRODUCT);
      expect(result).toMatchObject({ available: true, openCRs: 0, openBugs: 0 });
    });
  });

  describe('Atlassian failure paths', () => {
    it('429 → rate_limited cached 60s', async () => {
      mockRedisGet.mockResolvedValue(null);
      mockFetchOnce(429);

      const result = await getTicketCounts(PRODUCT);
      expect(result).toEqual({ available: false, reason: 'rate_limited' });
      expect(mockRedisSet).toHaveBeenCalledWith(
        getCacheKey(PRODUCT),
        expect.any(String),
        'EX',
        60,
      );
    });

    it('401 → auth_failed, sets global auth-failure key with 15s TTL (R1 FIX#1)', async () => {
      mockRedisGet.mockResolvedValue(null);
      mockFetchOnce(401);

      const result = await getTicketCounts(PRODUCT);
      expect(result).toEqual({ available: false, reason: 'auth_failed' });
      // Per-product ticket cache NOT written; the auth-failure key IS.
      expect(mockRedisSet).toHaveBeenCalledTimes(1);
      const [key, , , ttl] = mockRedisSet.mock.calls[0]!;
      expect(key).toBe('jira:auth-failure');
      expect(ttl).toBe(15);
    });

    it('403 → auth_failed (same path as 401)', async () => {
      mockRedisGet.mockResolvedValue(null);
      mockFetchOnce(403);

      const result = await getTicketCounts(PRODUCT);
      expect(result).toEqual({ available: false, reason: 'auth_failed' });
    });

    it('500 → upstream_unavailable cached 60s', async () => {
      mockRedisGet.mockResolvedValue(null);
      mockFetchOnce(500);

      const result = await getTicketCounts(PRODUCT);
      expect(result).toEqual({ available: false, reason: 'upstream_unavailable' });
      expect(mockRedisSet).toHaveBeenCalledWith(
        getCacheKey(PRODUCT),
        expect.any(String),
        'EX',
        60,
      );
    });

    it('network error → upstream_unavailable cached 60s', async () => {
      mockRedisGet.mockResolvedValue(null);
      globalThis.fetch = vi.fn().mockRejectedValueOnce(new TypeError('ECONNREFUSED')) as unknown as typeof fetch;

      const result = await getTicketCounts(PRODUCT);
      expect(result).toEqual({ available: false, reason: 'upstream_unavailable' });
    });

    it('200 with malformed JSON → upstream_unavailable cached 60s', async () => {
      mockRedisGet.mockResolvedValue(null);
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: () => Promise.reject(new SyntaxError('bad json')),
      } as unknown as Response) as unknown as typeof fetch;

      const result = await getTicketCounts(PRODUCT);
      expect(result).toEqual({ available: false, reason: 'upstream_unavailable' });
    });
  });

  describe('clearAuthCache', () => {
    it('DELs the global auth-failure marker so the next request retries Atlassian', async () => {
      await clearAuthCache();
      expect(mockRedisDel).toHaveBeenCalledWith('jira:auth-failure');
    });

    it('swallows Redis DEL errors (non-fatal)', async () => {
      mockRedisDel.mockRejectedValueOnce(new Error('Redis down'));
      await expect(clearAuthCache()).resolves.toBeUndefined();
    });
  });
});
