// Authorized by HUB-216 — unit tests for traceparent Fastify plugin
import { describe, it, expect, afterEach } from 'vitest';
import Fastify from 'fastify';
import { Writable } from 'stream';
import pino from 'pino';
import traceparentPlugin from '../plugin.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

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

async function makeApp(dest: Writable) {
  const fastify = Fastify({
    loggerInstance: pino({ level: 'trace', base: null }, dest),
    disableRequestLogging: true,
  });
  await fastify.register(traceparentPlugin);
  fastify.get('/test', (request, reply) => {
    request.log.info('test-handler-reached');
    return reply.send({ ok: true });
  });
  return fastify;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('traceparent plugin', () => {
  let app: Awaited<ReturnType<typeof makeApp>> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('extracts trace_id and span_id from a valid traceparent header', async () => {
    const { dest, lines } = makeCapture();
    app = await makeApp(dest);
    const traceId = 'a'.repeat(32);
    const parentId = 'b'.repeat(16);
    await app.inject({
      method: 'GET',
      url: '/test',
      headers: { traceparent: `00-${traceId}-${parentId}-01` },
    });
    const log = lines().find((l) => l.msg === 'test-handler-reached');
    expect(log).toBeDefined();
    expect(log!.trace_id).toBe(traceId);
    expect(log!.span_id).toBe(parentId);
  });

  it('sets trace_id and span_id to null when no traceparent header is present', async () => {
    const { dest, lines } = makeCapture();
    app = await makeApp(dest);
    await app.inject({ method: 'GET', url: '/test' });
    const log = lines().find((l) => l.msg === 'test-handler-reached');
    expect(log).toBeDefined();
    expect(log!.trace_id).toBeNull();
    expect(log!.span_id).toBeNull();
  });

  it('trace_id and span_id are present as keys (not absent) when null', async () => {
    const { dest, lines } = makeCapture();
    app = await makeApp(dest);
    await app.inject({ method: 'GET', url: '/test' });
    const log = lines().find((l) => l.msg === 'test-handler-reached');
    expect(log).toHaveProperty('trace_id');
    expect(log).toHaveProperty('span_id');
  });

  it('sets both to null and emits a warn when traceparent header is malformed', async () => {
    const { dest, lines } = makeCapture();
    app = await makeApp(dest);
    await app.inject({
      method: 'GET',
      url: '/test',
      headers: { traceparent: 'not-valid-traceparent' },
    });
    const log = lines().find((l) => l.msg === 'test-handler-reached');
    expect(log!.trace_id).toBeNull();
    expect(log!.span_id).toBeNull();
    // warn emitted for the invalid header
    const warnLog = lines().find((l) => (l.level as number) === 40);
    expect(warnLog).toBeDefined();
    expect(warnLog!.msg as string).toContain('invalid traceparent');
  });

  it('sets both to null when traceparent has wrong version prefix', async () => {
    const { dest, lines } = makeCapture();
    app = await makeApp(dest);
    const traceId = 'c'.repeat(32);
    const parentId = 'd'.repeat(16);
    await app.inject({
      method: 'GET',
      url: '/test',
      headers: { traceparent: `01-${traceId}-${parentId}-00` }, // version 01 not recognised
    });
    const log = lines().find((l) => l.msg === 'test-handler-reached');
    expect(log!.trace_id).toBeNull();
    expect(log!.span_id).toBeNull();
  });

  it('the warn emitted on invalid header also carries trace_id: null', async () => {
    const { dest, lines } = makeCapture();
    app = await makeApp(dest);
    await app.inject({
      method: 'GET',
      url: '/test',
      headers: { traceparent: 'bad-value' },
    });
    const warnLog = lines().find((l) => (l.level as number) === 40);
    expect(warnLog).toBeDefined();
    // The warn is emitted AFTER rebinding, so it carries trace_id: null
    expect(warnLog!.trace_id).toBeNull();
    expect(warnLog!.span_id).toBeNull();
  });
});
