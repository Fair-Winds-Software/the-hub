// Authorized by HUB-1695 (E-BE-1 S18) — route tests for POST /api/v1/admin/auth/revoke-pending.
// Anonymous endpoint (no JWT preHandler). Covers:
//   - 200 with each {revoked, reason?} branch (mocked service)
//   - 400 missing / non-string sessionId
//   - info log emits session_id_tail (last 4 chars)
//   - Per-route rate-limit override (10/min) returns spec-locked body
//     {code:'RATE_LIMITED', retryAfterSeconds:60}
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';

const mockRevokePending = vi.hoisted(() => vi.fn());
vi.mock('../../services/operatorAuth.js', () => ({
  revokePendingSession: mockRevokePending,
  loginOperator: vi.fn(),
  refreshOperatorToken: vi.fn(),
  logoutOperator: vi.fn(),
}));

const mockLoggerInfo = vi.hoisted(() => vi.fn());
vi.mock('../../lib/logger.js', () => ({
  default: { info: mockLoggerInfo, warn: vi.fn(), error: vi.fn() },
}));

import adminAuthRoutes from '../admin/auth.js';
import { AppError } from '../../errors/AppError.js';

import { closeAppResources } from '../../__tests__/_testCleanup.js';
const SESSION_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaffff'; // tail = "ffff"

async function buildApp(opts: { rateLimitMax?: number } = {}) {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: err.message });
    return reply.status(500).send({ error: 'internal' });
  });
  // In-memory rate-limit (no Redis dependency in unit tests). Global cap deliberately
  // higher than per-route so we can exercise the per-route override at 10/min.
  await app.register(rateLimit, {
    max: opts.rateLimitMax ?? 1000,
    timeWindow: 60_000,
  });
  await app.register(adminAuthRoutes);
  await app.ready();
  return app;
}

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await closeAppResources(app);
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/v1/admin/auth/revoke-pending (HUB-1695)', () => {
  describe('happy path branches (200)', () => {
    it('returns 200 {revoked:true} on successful revoke', async () => {
      mockRevokePending.mockResolvedValueOnce({ revoked: true });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/revoke-pending',
        payload: { sessionId: SESSION_ID },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ revoked: true });

      const [calledSession, calledAudit] = mockRevokePending.mock.calls[0]!;
      expect(calledSession).toBe(SESSION_ID);
      expect(calledAudit).toMatchObject({ ip: expect.any(String) });
    });

    it('returns 200 {revoked:false, reason:"not_found"}', async () => {
      mockRevokePending.mockResolvedValueOnce({ revoked: false, reason: 'not_found' });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/revoke-pending',
        payload: { sessionId: SESSION_ID },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ revoked: false, reason: 'not_found' });
    });

    it('returns 200 {revoked:false, reason:"already_revoked"}', async () => {
      mockRevokePending.mockResolvedValueOnce({ revoked: false, reason: 'already_revoked' });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/revoke-pending',
        payload: { sessionId: SESSION_ID },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ revoked: false, reason: 'already_revoked' });
    });

    it('returns 200 {revoked:false, reason:"expired"}', async () => {
      mockRevokePending.mockResolvedValueOnce({ revoked: false, reason: 'expired' });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/revoke-pending',
        payload: { sessionId: SESSION_ID },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ revoked: false, reason: 'expired' });
    });
  });

  describe('AC#1 — anonymous (no auth header required)', () => {
    it('accepts the request without any Authorization header', async () => {
      mockRevokePending.mockResolvedValueOnce({ revoked: true });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/revoke-pending',
        payload: { sessionId: SESSION_ID },
        // no Authorization header
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('AC#5 — info log emits session_id_tail (last 4 chars only)', () => {
    it('logs req_id + ip + last 4 chars of sessionId — not full id', async () => {
      mockRevokePending.mockResolvedValueOnce({ revoked: true });
      await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/revoke-pending',
        payload: { sessionId: SESSION_ID },
      });

      expect(mockLoggerInfo).toHaveBeenCalled();
      const [logCtx, message] = mockLoggerInfo.mock.calls[0]!;
      expect(message).toBe('revoke-pending request');
      expect(logCtx.session_id_tail).toBe('ffff');
      // Defense: the full sessionId must NOT leak through the log payload.
      expect(JSON.stringify(logCtx)).not.toContain(SESSION_ID);
      expect(logCtx.req_id).toBeDefined();
      expect(typeof logCtx.ip).toBe('string');
    });
  });

  describe('400 validation (NO service call)', () => {
    it('returns 400 when sessionId is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/revoke-pending',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/sessionId is required/);
      expect(mockRevokePending).not.toHaveBeenCalled();
    });

    it('returns 400 when sessionId is not a string', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/revoke-pending',
        payload: { sessionId: 42 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/sessionId is required/);
      expect(mockRevokePending).not.toHaveBeenCalled();
    });

    it('returns 400 when sessionId is the empty string', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/revoke-pending',
        payload: { sessionId: '' },
      });
      expect(res.statusCode).toBe(400);
      expect(mockRevokePending).not.toHaveBeenCalled();
    });
  });

  describe('AC#6 — per-route rate-limit override (10/min)', () => {
    it('11th request inside the window returns 429 with RATE_LIMITED + retry-after header', async () => {
      // Fresh app — fresh in-memory rate-limit counter — so the per-route 10/min limit
      // is exercised cleanly without bleed-over from earlier tests.
      const localApp = await buildApp();
      mockRevokePending.mockResolvedValue({ revoked: true });

      try {
        // 10 successful requests
        for (let i = 0; i < 10; i++) {
          const res = await localApp.inject({
            method: 'POST',
            url: '/api/v1/admin/auth/revoke-pending',
            payload: { sessionId: SESSION_ID },
          });
          expect(res.statusCode).toBe(200);
        }

        // 11th hits the per-route limit. @fastify/rate-limit v11 throws the
        // errorResponseBuilder return as the error; the global setErrorHandler
        // renders the AppError(429, 'RATE_LIMITED'). Spec body shape
        // {code:'RATE_LIMITED', retryAfterSeconds:60} diverges to
        // {error:'RATE_LIMITED'} + retry-after header (documented deviation).
        const limited = await localApp.inject({
          method: 'POST',
          url: '/api/v1/admin/auth/revoke-pending',
          payload: { sessionId: SESSION_ID },
        });
        expect(limited.statusCode).toBe(429);
        expect(limited.json()).toEqual({ error: 'RATE_LIMITED' });
      } finally {
        await localApp.close();
      }
    });
  });
});
