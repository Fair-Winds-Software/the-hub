// Authorized by HUB-1570 — integration tests for the SPA-shell middleware (S1b of HUB-1555)
// Covers ACs 1-6: static serve + immutable cache (AC#1), API route precedence (AC#2),
// SPA fallback for non-API GETs (AC#3 + AC#5), 404 for non-GET unknown (AC#4),
// operational route whitelist (AC#6).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import spaShellPlugin from '../../src/plugins/spaShell.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIST = path.join(__dirname, 'spaShell.fixtures', 'dist');

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Mimic an existing API route to verify precedence (AC#2).
  app.get('/api/v1/health', async () => ({ status: 'ok' }));

  // Mimic operational routes to verify whitelist (AC#6).
  app.get('/health', async () => ({ status: 'ok' }));

  await app.register(spaShellPlugin, { distPath: FIXTURE_DIST });
  await app.ready();
  return app;
}

describe('spaShellPlugin (HUB-1570)', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  let app: FastifyInstance;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
  });

  afterEach(async () => {
    if (app) await app.close();
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('AC#1: serves hashed assets with immutable cache headers', async () => {
    app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/assets/index.fixture.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.body).toContain('fixture');
  });

  it('AC#2: API routes take precedence over SPA shell', async () => {
    app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
  });

  it('AC#3 + AC#5: non-API GET deep link returns index.html with 200 + text/html', async () => {
    app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/console/products/abc-123' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body).toContain('<div id="root">');
  });

  it('AC#4: POST to unknown route returns 404 (no SPA fallback)', async () => {
    app = await buildTestApp();
    const res = await app.inject({ method: 'POST', url: '/unknown-route' });
    expect(res.statusCode).toBe(404);
  });

  it('AC#6: operational route /health is not shadowed by SPA fallback', async () => {
    app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('AC#6: unknown /api/v1/* path returns 404 (NOT the SPA shell)', async () => {
    app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).not.toContain('text/html');
  });

  it('no-ops in development mode (D-HUB-SCOPE-025 — Vite owns SPA shell in dev)', async () => {
    process.env.NODE_ENV = 'development';
    const devApp = Fastify({ logger: false });
    devApp.get('/api/v1/health', async () => ({ status: 'ok' }));
    await devApp.register(spaShellPlugin, { distPath: FIXTURE_DIST });
    await devApp.ready();
    const res = await devApp.inject({ method: 'GET', url: '/console/products/abc-123' });
    // Fastify default 404 (no SPA fallback registered in dev)
    expect(res.statusCode).toBe(404);
    await devApp.close();
  });
});
