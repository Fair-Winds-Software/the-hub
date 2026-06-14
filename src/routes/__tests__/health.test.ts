// Authorized by HUB-230 — unit tests for deriveStatus(); integration tests for GET /health route
import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify from 'fastify';

vi.mock('../../health/probes.js', () => ({ runHealthChecks: vi.fn() }));

import { runHealthChecks } from '../../health/probes.js';
import healthRoutes, { deriveStatus } from '../health.js';

// ── deriveStatus() unit tests ─────────────────────────────────────────────────

describe('deriveStatus()', () => {
  it('returns "ok" when all probes return "ok"', () => {
    expect(deriveStatus({ pg: 'ok', redis: 'ok', stripe: 'ok' })).toBe('ok');
  });

  it('returns "ok" when stripe is "disabled" and pg + redis are "ok"', () => {
    expect(deriveStatus({ pg: 'ok', redis: 'ok', stripe: 'disabled' })).toBe('ok');
  });

  it('returns "degraded" when pg returns "error"', () => {
    expect(deriveStatus({ pg: 'error', redis: 'ok', stripe: 'ok' })).toBe('degraded');
  });

  it('returns "degraded" when redis returns "error"', () => {
    expect(deriveStatus({ pg: 'ok', redis: 'error', stripe: 'ok' })).toBe('degraded');
  });

  it('returns "degraded" when stripe returns "error"', () => {
    expect(deriveStatus({ pg: 'ok', redis: 'ok', stripe: 'error' })).toBe('degraded');
  });

  it('returns "degraded" when any probe returns "timeout"', () => {
    expect(deriveStatus({ pg: 'timeout', redis: 'ok', stripe: 'ok' })).toBe('degraded');
    expect(deriveStatus({ pg: 'ok', redis: 'timeout', stripe: 'ok' })).toBe('degraded');
  });

  it('returns "degraded" when pg errors even with stripe "disabled"', () => {
    expect(deriveStatus({ pg: 'error', redis: 'ok', stripe: 'disabled' })).toBe('degraded');
  });
});

// ── GET /health route integration ─────────────────────────────────────────────

async function buildTestApp() {
  const fastify = Fastify({ logger: false });
  await fastify.register(healthRoutes);
  return fastify;
}

afterEach(() => {
  vi.clearAllMocks();
});

// ── All probes succeed ────────────────────────────────────────────────────────

describe('GET /health — all probes ok', () => {
  it('returns HTTP 200 with {status:"ok", checks:{pg,redis,stripe}}', async () => {
    vi.mocked(runHealthChecks).mockResolvedValue({ pg: 'ok', redis: 'ok', stripe: 'ok' });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ status: string; checks: Record<string, string> }>();
      expect(body.status).toBe('ok');
      expect(body.checks).toEqual({ pg: 'ok', redis: 'ok', stripe: 'ok' });
    } finally {
      await fastify.close();
    }
  });

  it('is reachable with no auth headers — not 401 or 403', async () => {
    vi.mocked(runHealthChecks).mockResolvedValue({ pg: 'ok', redis: 'ok', stripe: 'ok' });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).not.toBe(401);
      expect(res.statusCode).not.toBe(403);
    } finally {
      await fastify.close();
    }
  });
});

// ── Probe failures ────────────────────────────────────────────────────────────

describe('GET /health — probe failure', () => {
  it('returns HTTP 503 with status:"degraded" when pg is "error"', async () => {
    vi.mocked(runHealthChecks).mockResolvedValue({ pg: 'error', redis: 'ok', stripe: 'ok' });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(503);
      const body = res.json<{ status: string; checks: Record<string, string> }>();
      expect(body.status).toBe('degraded');
      expect(body.checks.pg).toBe('error');
      expect(body.checks.redis).toBe('ok');
      expect(body.checks.stripe).toBe('ok');
    } finally {
      await fastify.close();
    }
  });

  it('preserves "timeout" as-is in the body — not remapped to "error"', async () => {
    vi.mocked(runHealthChecks).mockResolvedValue({ pg: 'ok', redis: 'timeout', stripe: 'ok' });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(503);
      const body = res.json<{ status: string; checks: Record<string, string> }>();
      expect(body.status).toBe('degraded');
      expect(body.checks.redis).toBe('timeout');
    } finally {
      await fastify.close();
    }
  });

  it('all check results are always present in the body even on partial failure', async () => {
    vi.mocked(runHealthChecks).mockResolvedValue({ pg: 'error', redis: 'ok', stripe: 'ok' });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({ method: 'GET', url: '/health' });
      const body = res.json<{ status: string; checks: Record<string, string> }>();
      expect(body.checks).toHaveProperty('pg');
      expect(body.checks).toHaveProperty('redis');
      expect(body.checks).toHaveProperty('stripe');
    } finally {
      await fastify.close();
    }
  });
});

// ── Stripe disabled ───────────────────────────────────────────────────────────

describe('GET /health — stripe disabled', () => {
  it('returns HTTP 200 when stripe is "disabled" and pg+redis are "ok"', async () => {
    vi.mocked(runHealthChecks).mockResolvedValue({ pg: 'ok', redis: 'ok', stripe: 'disabled' });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ status: string; checks: Record<string, string> }>();
      expect(body.status).toBe('ok');
      expect(body.checks.stripe).toBe('disabled');
    } finally {
      await fastify.close();
    }
  });

  it('"disabled" alone does not trigger 503 — pg+redis determine overall status', async () => {
    vi.mocked(runHealthChecks).mockResolvedValue({ pg: 'error', redis: 'ok', stripe: 'disabled' });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(503);
      const body = res.json<{ status: string; checks: Record<string, string> }>();
      expect(body.status).toBe('degraded');
      expect(body.checks.stripe).toBe('disabled');
    } finally {
      await fastify.close();
    }
  });
});
