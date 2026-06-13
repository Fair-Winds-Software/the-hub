// Authorized by HUB-113 — Full middleware chain integration test: CORS → Logger → ErrorHandler → RateLimit → Auth → OperatorAuth
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { buildApp } from '../app.js';
import { closePool } from '../db/pool.js';
import { closeRedis } from '../redis/client.js';
import { AppError } from '../errors/AppError.js';

const TEST_TENANT_ID = 'cccccccc-0000-0000-0000-000000000001';
const TEST_PRODUCT_ID = 'cccccccc-0000-0000-0000-000000000002';
const TEST_CLIENT_ID = 'cccccccc-0000-0000-0000-000000000003';
const TEST_SECRET = 'correct-horse-battery-staple-hub113';
const ALLOWED_ORIGIN = 'https://app.mavericklaunched.com';
const DISALLOWED_ORIGIN = 'https://evil.example.com';

let client: Client;

beforeAll(async () => {
  process.env.DATABASE_URL ??= 'postgresql://hub:hub@localhost:5432/hub_dev';
  process.env.REDIS_URL ??= 'redis://localhost:6379';
  process.env.JWT_SECRET ??= 'test-jwt-secret-hub113';
  process.env.OPERATOR_JWT_SECRET ??= 'test-operator-jwt-secret-hub113';
  process.env.JWT_EXPIRES_IN = '900';
  process.env.BCRYPT_ROUNDS = '1';
  process.env.CORS_ORIGINS = ALLOWED_ORIGIN;
  process.env.NODE_ENV = 'test';

  client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const hash = await bcrypt.hash(TEST_SECRET, 1);

  await client.query(
    `INSERT INTO tenants (id, name, tenant_type) VALUES ($1, 'HUB-113 Test Tenant', 'external') ON CONFLICT DO NOTHING`,
    [TEST_TENANT_ID],
  );
  await client.query(
    `INSERT INTO products (id, tenant_id, name, slug) VALUES ($1, $2, 'HUB-113 Test Product', 'hub113-test-product') ON CONFLICT DO NOTHING`,
    [TEST_PRODUCT_ID, TEST_TENANT_ID],
  );
  await client.query(
    `INSERT INTO product_registrations (id, product_id, client_id, client_secret_hash)
     VALUES (gen_random_uuid(), $1, $2, $3) ON CONFLICT DO NOTHING`,
    [TEST_PRODUCT_ID, TEST_CLIENT_ID, hash],
  );
});

afterAll(async () => {
  await client.query(`DELETE FROM product_registrations WHERE client_id = $1`, [TEST_CLIENT_ID]);
  await client.query(`DELETE FROM products WHERE id = $1`, [TEST_PRODUCT_ID]);
  await client.query(`DELETE FROM tenants WHERE id = $1`, [TEST_TENANT_ID]);
  // Restore wildcard for other test suites
  process.env.CORS_ORIGINS = '*';
  await client.end();
  await closePool();
  await closeRedis();
});

// ── CORS behaviour ───────────────────────────────────────────────────────────

describe('CORS — preflight and origin policy', () => {
  it('OPTIONS preflight from allowed origin → 204 with Access-Control-Allow-* headers', async () => {
    const fastify = await buildApp();
    try {
      const res = await fastify.inject({
        method: 'OPTIONS',
        url: '/api/v1/health/live',
        headers: {
          origin: ALLOWED_ORIGIN,
          'access-control-request-method': 'GET',
        },
      });
      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
      expect(res.headers['access-control-allow-methods']).toBeDefined();
    } finally {
      await fastify.close();
    }
  });

  it('CORS exposed headers include X-RateLimit-Limit, X-RateLimit-Remaining, Retry-After', async () => {
    const fastify = await buildApp();
    try {
      const res = await fastify.inject({
        method: 'OPTIONS',
        url: '/api/v1/health/live',
        headers: {
          origin: ALLOWED_ORIGIN,
          'access-control-request-method': 'GET',
        },
      });
      const exposed = res.headers['access-control-expose-headers'] ?? '';
      expect(exposed).toMatch(/x-ratelimit-limit/i);
      expect(exposed).toMatch(/x-ratelimit-remaining/i);
      expect(exposed).toMatch(/retry-after/i);
    } finally {
      await fastify.close();
    }
  });

  it('request from disallowed origin → no Access-Control-Allow-Origin header', async () => {
    const fastify = await buildApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: '/api/v1/health/live',
        headers: { origin: DISALLOWED_ORIGIN },
      });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await fastify.close();
    }
  });
});

// ── Full chain composed behaviour ────────────────────────────────────────────

describe('Middleware chain — composed end-to-end', () => {
  it('unauthenticated request to guarded route → 401 canonical shape', async () => {
    const fastify = await buildApp();
    fastify.get('/test-chain-guarded', { preHandler: [fastify.authenticate] }, () => ({ ok: true }));
    try {
      const res = await fastify.inject({ method: 'GET', url: '/test-chain-guarded' });
      expect(res.statusCode).toBe(401);
      const body = res.json<{ error: { code: number; message: string } }>();
      expect(body.error.code).toBe(401);
      expect(body.error.message).toBe('Invalid or expired token');
    } finally {
      await fastify.close();
    }
  });

  it('authenticated request (valid JWT) → 200', async () => {
    const fastify = await buildApp();
    fastify.get(
      '/test-chain-authenticated',
      { preHandler: [fastify.authenticate] },
      (request) => ({ tenant_id: request.tenant_id, product_id: request.product_id }),
    );
    try {
      const token = jwt.sign(
        { tenant_id: TEST_TENANT_ID, product_id: TEST_PRODUCT_ID },
        process.env.JWT_SECRET!,
        { expiresIn: 900 },
      );
      const res = await fastify.inject({
        method: 'GET',
        url: '/test-chain-authenticated',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ tenant_id: string; product_id: string }>();
      expect(body.tenant_id).toBe(TEST_TENANT_ID);
      expect(body.product_id).toBe(TEST_PRODUCT_ID);
    } finally {
      await fastify.close();
    }
  });

  it('full auth flow: POST /auth/token → JWT → protected route → 200', async () => {
    const fastify = await buildApp();
    fastify.get(
      '/test-chain-full-flow',
      { preHandler: [fastify.authenticate] },
      () => ({ success: true }),
    );
    try {
      const tokenRes = await fastify.inject({
        method: 'POST',
        url: '/api/v1/auth/token',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: TEST_CLIENT_ID, client_secret: TEST_SECRET }),
      });
      expect(tokenRes.statusCode).toBe(200);
      const { access_token } = tokenRes.json<{ access_token: string }>();

      const res = await fastify.inject({
        method: 'GET',
        url: '/test-chain-full-flow',
        headers: { authorization: `Bearer ${access_token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ success: boolean }>().success).toBe(true);
    } finally {
      await fastify.close();
    }
  });

  it('unmapped route → 404 canonical shape', async () => {
    const fastify = await buildApp();
    try {
      const res = await fastify.inject({ method: 'GET', url: '/no-such-route-hub113' });
      expect(res.statusCode).toBe(404);
      const body = res.json<{ error: { code: number; message: string } }>();
      expect(body.error.code).toBe(404);
      expect(body.error.message).toBe('Route not found');
    } finally {
      await fastify.close();
    }
  });

  it('AppError from route → correct status + canonical shape (error handler integration)', async () => {
    const fastify = await buildApp();
    fastify.get('/test-chain-app-error', () => {
      throw new AppError(422, 'Unprocessable entity');
    });
    try {
      const res = await fastify.inject({ method: 'GET', url: '/test-chain-app-error' });
      expect(res.statusCode).toBe(422);
      const body = res.json<{ error: { code: number; message: string } }>();
      expect(body.error.code).toBe(422);
      expect(body.error.message).toBe('Unprocessable entity');
    } finally {
      await fastify.close();
    }
  });
});

// ── CORS_ORIGINS env parsing ──────────────────────────────────────────────────

describe('CORS_ORIGINS env parsing', () => {
  it('comma-separated list allows each origin independently', async () => {
    const prev = process.env.CORS_ORIGINS;
    process.env.CORS_ORIGINS = `${ALLOWED_ORIGIN}, https://other.example.com`;
    const fastify = await buildApp();
    try {
      const res = await fastify.inject({
        method: 'OPTIONS',
        url: '/api/v1/health/live',
        headers: {
          origin: 'https://other.example.com',
          'access-control-request-method': 'GET',
        },
      });
      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('https://other.example.com');
    } finally {
      await fastify.close();
      process.env.CORS_ORIGINS = prev;
    }
  });

  it('CORS_ORIGINS=* allows any origin', async () => {
    const prev = process.env.CORS_ORIGINS;
    process.env.CORS_ORIGINS = '*';
    const fastify = await buildApp();
    try {
      const res = await fastify.inject({
        method: 'OPTIONS',
        url: '/api/v1/health/live',
        headers: {
          origin: DISALLOWED_ORIGIN,
          'access-control-request-method': 'GET',
        },
      });
      expect(res.statusCode).toBe(204);
      // When origin:true, @fastify/cors reflects the request Origin header
      expect(res.headers['access-control-allow-origin']).toBeDefined();
    } finally {
      await fastify.close();
      process.env.CORS_ORIGINS = prev;
    }
  });
});
