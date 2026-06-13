// Authorized by HUB-98 — Service auth middleware: token issuance, JWT preHandler
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { buildApp } from '../app.js';
import { closePool } from '../db/pool.js';
import { closeRedis } from '../redis/client.js';

// Fixed UUIDs for test data — cleaned up in afterAll
const TEST_TENANT_ID = 'bbbbbbbb-0000-0000-0000-000000000001';
const TEST_PRODUCT_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const TEST_CLIENT_ID = 'bbbbbbbb-0000-0000-0000-000000000003';
const TEST_SECRET = 'correct-horse-battery-staple-hub98';

let client: Client;

beforeAll(async () => {
  process.env.DATABASE_URL ??= 'postgresql://hub:hub@localhost:5432/hub_dev';
  process.env.REDIS_URL ??= 'redis://localhost:6379';
  process.env.JWT_SECRET ??= 'test-jwt-secret-hub98';
  process.env.OPERATOR_JWT_SECRET ??= 'test-operator-jwt-secret-hub112';
  process.env.JWT_EXPIRES_IN = '900';
  // Use 1 bcrypt round in tests so buildApp() (which pre-hashes a dummy) is fast
  process.env.BCRYPT_ROUNDS = '1';
  process.env.NODE_ENV = 'test';

  client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const hash = await bcrypt.hash(TEST_SECRET, 1);

  await client.query(
    `INSERT INTO tenants (id, name, tenant_type) VALUES ($1, 'HUB-98 Test Tenant', 'external') ON CONFLICT DO NOTHING`,
    [TEST_TENANT_ID],
  );
  await client.query(
    `INSERT INTO products (id, tenant_id, name, slug) VALUES ($1, $2, 'HUB-98 Test Product', 'hub98-test-product') ON CONFLICT DO NOTHING`,
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
  await client.end();
  await closePool();
  await closeRedis();
});

// ── AC1–3: Token issuance ────────────────────────────────────────────────────

describe('AC1–3 — POST /api/v1/auth/token success', () => {
  it('returns 200 with access_token and expires_in: 900', async () => {
    const fastify = await buildApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/auth/token',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: TEST_CLIENT_ID, client_secret: TEST_SECRET }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ access_token: string; expires_in: number }>();
      expect(body.expires_in).toBe(900);
      expect(typeof body.access_token).toBe('string');
      expect(body.access_token.split('.').length).toBe(3);
    } finally {
      await fastify.close();
    }
  });

  it('AC4 — JWT payload contains exactly {tenant_id, product_id, iat, exp}', async () => {
    const fastify = await buildApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/auth/token',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: TEST_CLIENT_ID, client_secret: TEST_SECRET }),
      });
      const { access_token } = res.json<{ access_token: string }>();
      const payload = jwt.verify(
        access_token,
        process.env.JWT_SECRET!,
      ) as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'product_id', 'tenant_id']);
      expect(payload.tenant_id).toBe(TEST_TENANT_ID);
      expect(payload.product_id).toBe(TEST_PRODUCT_ID);
    } finally {
      await fastify.close();
    }
  });
});

// ── AC5–6: 401 — same message for both failure modes ─────────────────────────

describe('AC5–6 — 401 prevents enumeration', () => {
  it('unknown client_id → 401 "Invalid credentials"', async () => {
    const fastify = await buildApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/auth/token',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: '00000000-dead-dead-dead-000000000000',
          client_secret: 'x',
        }),
      });
      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { message: string } }>().error.message).toBe('Invalid credentials');
    } finally {
      await fastify.close();
    }
  });

  it('correct client_id + wrong secret → 401 same message (no enumeration)', async () => {
    const fastify = await buildApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/auth/token',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: TEST_CLIENT_ID, client_secret: 'wrong-secret' }),
      });
      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { message: string } }>().error.message).toBe('Invalid credentials');
    } finally {
      await fastify.close();
    }
  });
});

// ── AC7: JWT preHandler (fastify.authenticate) ───────────────────────────────

describe('AC7 — fastify.authenticate preHandler', () => {
  it('valid Bearer token → 200, request.tenant_id and product_id set', async () => {
    const fastify = await buildApp();
    fastify.get(
      '/test-auth-guard',
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
        url: '/test-auth-guard',
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

  it('missing Authorization header → 401 "Invalid or expired token"', async () => {
    const fastify = await buildApp();
    fastify.get('/test-no-header', { preHandler: [fastify.authenticate] }, () => ({ ok: true }));
    try {
      const res = await fastify.inject({ method: 'GET', url: '/test-no-header' });
      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { message: string } }>().error.message).toBe(
        'Invalid or expired token',
      );
    } finally {
      await fastify.close();
    }
  });

  it('expired token → 401', async () => {
    const fastify = await buildApp();
    fastify.get('/test-expired', { preHandler: [fastify.authenticate] }, () => ({ ok: true }));
    try {
      const token = jwt.sign(
        { tenant_id: TEST_TENANT_ID, product_id: TEST_PRODUCT_ID },
        process.env.JWT_SECRET!,
        { expiresIn: -1 },
      );
      const res = await fastify.inject({
        method: 'GET',
        url: '/test-expired',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await fastify.close();
    }
  });

  it('tampered signature → 401', async () => {
    const fastify = await buildApp();
    fastify.get('/test-tampered', { preHandler: [fastify.authenticate] }, () => ({ ok: true }));
    try {
      const token = jwt.sign(
        { tenant_id: TEST_TENANT_ID, product_id: TEST_PRODUCT_ID },
        'wrong-signing-secret',
        { expiresIn: 900 },
      );
      const res = await fastify.inject({
        method: 'GET',
        url: '/test-tampered',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await fastify.close();
    }
  });

  it('malformed Authorization (not "Bearer ") → 401', async () => {
    const fastify = await buildApp();
    fastify.get('/test-malformed', { preHandler: [fastify.authenticate] }, () => ({ ok: true }));
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: '/test-malformed',
        headers: { authorization: 'Token abc123' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await fastify.close();
    }
  });
});

// ── AC8: /auth/token is unprotected ─────────────────────────────────────────

describe('AC8 — /api/v1/auth/token is not behind JWT guard', () => {
  it('reaches /auth/token without Authorization header', async () => {
    const fastify = await buildApp();
    try {
      // Sends request without Bearer — should get 401 for bad creds, not 401 for missing token
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/auth/token',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: '00000000-dead-dead-dead-000000000000', client_secret: 'x' }),
      });
      // 401 from credential check, not from JWT guard
      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { message: string } }>().error.message).toBe('Invalid credentials');
    } finally {
      await fastify.close();
    }
  });
});
