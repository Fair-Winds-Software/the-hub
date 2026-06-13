// Authorized by HUB-78 — Pino structured logger plugin: trace_id, fields, redaction, log-level
import { describe, it, expect, beforeAll, afterEach, beforeEach } from 'vitest';
import { Writable } from 'stream';
import { buildApp } from '../app.js';
import { closePool } from '../db/pool.js';
import { closeRedis } from '../redis/client.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Returns a Pino-compatible DestinationStream that buffers every JSON line.
 * Pino writes newline-delimited JSON chunks; we split on '\n' and parse each.
 * This bypasses sonic-boom so test log capture works reliably.
 */
function makeCapture(): { dest: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const dest = new Writable({
    write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return {
    dest,
    lines: () =>
      chunks
        .flatMap((s) => s.split('\n'))
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as Record<string, unknown>];
          } catch {
            return [];
          }
        }),
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgresql://hub:hub@localhost:5432/hub_dev';
  process.env.REDIS_URL ??= 'redis://localhost:6379';
  process.env.JWT_SECRET ??= 'test-jwt-secret-hub78';
  // Ensure raw JSON output (no pino-pretty) so lines are parseable
  process.env.NODE_ENV = 'test';
});

afterEach(async () => {
  await closePool();
  await closeRedis();
});

// ── AC1: trace_id is UUID v4 ─────────────────────────────────────────────────

describe('AC1 — trace_id', () => {
  it('every request log line carries a UUID v4 trace_id', async () => {
    const { dest, lines } = makeCapture();
    const fastify = await buildApp(dest);
    try {
      await fastify.inject({ method: 'GET', url: '/health' });
    } finally {
      await fastify.close();
    }
    // At minimum the onResponse hook emits one line per request
    const requestLines = lines().filter((l) => l.msg === 'request completed');
    expect(requestLines.length).toBeGreaterThanOrEqual(1);
    for (const line of requestLines) {
      expect(line.trace_id).toMatch(UUID_V4);
    }
  });

  it('each request gets a distinct trace_id', async () => {
    const { dest, lines } = makeCapture();
    const fastify = await buildApp(dest);
    try {
      await fastify.inject({ method: 'GET', url: '/health' });
      await fastify.inject({ method: 'GET', url: '/health' });
    } finally {
      await fastify.close();
    }
    const ids = lines()
      .filter((l) => l.msg === 'request completed')
      .map((l) => l.trace_id);
    expect(ids.length).toBe(2);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

// ── AC2: all 6 required fields present ───────────────────────────────────────

describe('AC2 — required log fields', () => {
  it('every request log line has {level, time, trace_id, tenant_id, product_id, msg}', async () => {
    const { dest, lines } = makeCapture();
    const fastify = await buildApp(dest);
    try {
      await fastify.inject({ method: 'GET', url: '/health' });
    } finally {
      await fastify.close();
    }
    const requestLines = lines().filter((l) => l.msg === 'request completed');
    expect(requestLines.length).toBeGreaterThanOrEqual(1);
    for (const line of requestLines) {
      expect(line).toHaveProperty('level');
      expect(line).toHaveProperty('time');
      expect(line).toHaveProperty('trace_id');
      expect(line).toHaveProperty('tenant_id');
      expect(line).toHaveProperty('product_id');
      expect(line).toHaveProperty('msg');
    }
  });

  it('tenant_id and product_id are null before auth resolves', async () => {
    const { dest, lines } = makeCapture();
    const fastify = await buildApp(dest);
    try {
      await fastify.inject({ method: 'GET', url: '/health' });
    } finally {
      await fastify.close();
    }
    const requestLines = lines().filter((l) => l.msg === 'request completed');
    for (const line of requestLines) {
      expect(line.tenant_id).toBeNull();
      expect(line.product_id).toBeNull();
    }
  });

  it('pid and hostname are absent (base:null removes them)', async () => {
    const { dest, lines } = makeCapture();
    const fastify = await buildApp(dest);
    try {
      await fastify.inject({ method: 'GET', url: '/health' });
    } finally {
      await fastify.close();
    }
    const requestLines = lines().filter((l) => l.msg === 'request completed');
    for (const line of requestLines) {
      expect(line).not.toHaveProperty('pid');
      expect(line).not.toHaveProperty('hostname');
    }
  });
});

// ── AC3: LOG_LEVEL controls verbosity ─────────────────────────────────────────

describe('AC3 — LOG_LEVEL', () => {
  let savedLevel: string | undefined;
  beforeEach(() => {
    savedLevel = process.env.LOG_LEVEL;
  });
  afterEach(() => {
    if (savedLevel !== undefined) {
      process.env.LOG_LEVEL = savedLevel;
    } else {
      delete process.env.LOG_LEVEL;
    }
  });

  it('LOG_LEVEL=warn suppresses info-level log lines', async () => {
    process.env.LOG_LEVEL = 'warn';
    const { dest, lines } = makeCapture();
    const fastify = await buildApp(dest);
    try {
      await fastify.inject({ method: 'GET', url: '/health' });
    } finally {
      await fastify.close();
    }
    // onResponse logs at info level — should be suppressed at warn
    const infoLines = lines().filter((l) => l.level === 30); // pino info = 30
    expect(infoLines.length).toBe(0);
  });

  it('LOG_LEVEL=info (default) emits request completed lines', async () => {
    delete process.env.LOG_LEVEL;
    const { dest, lines } = makeCapture();
    const fastify = await buildApp(dest);
    try {
      await fastify.inject({ method: 'GET', url: '/health' });
    } finally {
      await fastify.close();
    }
    const completedLines = lines().filter((l) => l.msg === 'request completed');
    expect(completedLines.length).toBeGreaterThanOrEqual(1);
  });
});

// ── AC5: credential redaction ─────────────────────────────────────────────────

describe('AC5 — credential redaction', () => {
  it('req.headers.authorization value never appears in logs (serializer strips headers)', async () => {
    // The req serializer strips all headers before Pino redact runs.
    // Protection is via omission — authorization header never reaches log output.
    const { dest, lines } = makeCapture();
    const fastify = await buildApp(dest);

    fastify.get('/test-redact-auth', (request, reply) => {
      request.log.info({ req: request.raw }, 'logging raw request');
      return reply.send({ ok: true });
    });

    try {
      await fastify.inject({
        method: 'GET',
        url: '/test-redact-auth',
        headers: { authorization: 'Bearer super-secret-token' },
      });
    } finally {
      await fastify.close();
    }

    const raw = JSON.stringify(lines());
    expect(raw).not.toContain('super-secret-token');
  });

  it('body.client_secret is redacted to [Redacted]', async () => {
    const { dest, lines } = makeCapture();
    const fastify = await buildApp(dest);

    fastify.post('/test-redact-body', (request, reply) => {
      request.log.info({ body: request.body }, 'logging body');
      return reply.send({ ok: true });
    });

    try {
      await fastify.inject({
        method: 'POST',
        url: '/test-redact-body',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_secret: 'my-secret-value', other: 'safe' }),
      });
    } finally {
      await fastify.close();
    }

    const raw = JSON.stringify(lines());
    expect(raw).not.toContain('my-secret-value');
    expect(raw).toContain('[Redacted]');
  });

  it('body.password is redacted to [Redacted]', async () => {
    const { dest, lines } = makeCapture();
    const fastify = await buildApp(dest);

    fastify.post('/test-redact-password', (request, reply) => {
      request.log.info({ body: request.body }, 'logging body');
      return reply.send({ ok: true });
    });

    try {
      await fastify.inject({
        method: 'POST',
        url: '/test-redact-password',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'hunter2', username: 'alice' }),
      });
    } finally {
      await fastify.close();
    }

    const raw = JSON.stringify(lines());
    expect(raw).not.toContain('hunter2');
    expect(raw).toContain('[Redacted]');
  });
});

// ── AC6: request.log available in route handlers ──────────────────────────────

describe('AC6 — request.log in route handlers', () => {
  it('request.log.info() in a handler produces a parseable JSON log line', async () => {
    const { dest, lines } = makeCapture();
    const fastify = await buildApp(dest);

    fastify.get('/test-request-log', (request, reply) => {
      request.log.info('handler reached');
      return reply.send({ ok: true });
    });

    try {
      await fastify.inject({ method: 'GET', url: '/test-request-log' });
    } finally {
      await fastify.close();
    }

    const handlerLines = lines().filter((l) => l.msg === 'handler reached');
    expect(handlerLines.length).toBe(1);
    expect(handlerLines[0].trace_id).toMatch(UUID_V4);
  });
});
