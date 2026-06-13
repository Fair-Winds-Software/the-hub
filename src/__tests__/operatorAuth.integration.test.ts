// Authorized by HUB-112 — Operator auth middleware: token issuance, JWT preHandler, requireRole
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { buildApp } from '../app.js';
import { closePool } from '../db/pool.js';
import { closeRedis } from '../redis/client.js';
import { requireRole } from '../plugins/operatorAuth.js';

const TEST_OPERATOR_USERNAME = 'hub112-test-operator';
const TEST_ADMIN_USERNAME = 'hub112-test-admin';
const TEST_PASSWORD = 'correct-horse-battery-staple-hub112';

let client: Client;

beforeAll(async () => {
  process.env.DATABASE_URL ??= 'postgresql://hub:hub@localhost:5432/hub_dev';
  process.env.REDIS_URL ??= 'redis://localhost:6379';
  process.env.JWT_SECRET ??= 'test-jwt-secret-hub98';
  process.env.OPERATOR_JWT_SECRET ??= 'test-operator-jwt-secret-hub112';
  process.env.OPERATOR_JWT_EXPIRES_IN = '3600';
  process.env.BCRYPT_ROUNDS = '1';
  process.env.NODE_ENV = 'test';

  client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const hash = await bcrypt.hash(TEST_PASSWORD, 1);

  await client.query(
    `INSERT INTO operators (username, password_hash, role)
     VALUES ($1, $2, 'operator') ON CONFLICT (username) DO NOTHING`,
    [TEST_OPERATOR_USERNAME, hash],
  );
  await client.query(
    `INSERT INTO operators (username, password_hash, role)
     VALUES ($1, $2, 'admin') ON CONFLICT (username) DO NOTHING`,
    [TEST_ADMIN_USERNAME, hash],
  );
});

afterAll(async () => {
  await client.query(`DELETE FROM operators WHERE username IN ($1, $2)`, [
    TEST_OPERATOR_USERNAME,
    TEST_ADMIN_USERNAME,
  ]);
  await client.end();
  await closePool();
  await closeRedis();
});

// ── Token issuance ───────────────────────────────────────────────────────────

describe('POST /api/v1/operator/auth/token — success', () => {
  it('returns 200 with access_token and expires_in: 3600', async () => {
    const fastify = await buildApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/operator/auth/token',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: TEST_OPERATOR_USERNAME, password: TEST_PASSWORD }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ access_token: string; expires_in: number }>();
      expect(body.expires_in).toBe(3600);
      expect(typeof body.access_token).toBe('string');
      expect(body.access_token.split('.').length).toBe(3);
    } finally {
      await fastify.close();
    }
  });

  it('JWT payload contains exactly {operator_id, role, iat, exp}', async () => {
    const fastify = await buildApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/operator/auth/token',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: TEST_OPERATOR_USERNAME, password: TEST_PASSWORD }),
      });
      const { access_token } = res.json<{ access_token: string }>();
      const payload = jwt.verify(
        access_token,
        process.env.OPERATOR_JWT_SECRET!,
      ) as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'operator_id', 'role']);
      expect(payload.role).toBe('operator');
      expect(typeof payload.operator_id).toBe('string');
    } finally {
      await fastify.close();
    }
  });
});

// ── 401 anti-enumeration ─────────────────────────────────────────────────────

describe('401 prevents enumeration', () => {
  it('unknown username → 401 "Invalid credentials"', async () => {
    const fastify = await buildApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/operator/auth/token',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'no-such-operator', password: 'x' }),
      });
      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { message: string } }>().error.message).toBe('Invalid credentials');
    } finally {
      await fastify.close();
    }
  });

  it('correct username + wrong password → 401 same message', async () => {
    const fastify = await buildApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/operator/auth/token',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: TEST_OPERATOR_USERNAME, password: 'wrong-password' }),
      });
      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { message: string } }>().error.message).toBe('Invalid credentials');
    } finally {
      await fastify.close();
    }
  });
});

// ── authenticateOperator preHandler ──────────────────────────────────────────

describe('fastify.authenticateOperator preHandler', () => {
  it('valid Bearer token → 200, operator_id and operator_role set', async () => {
    const fastify = await buildApp();
    fastify.get(
      '/test-op-auth-guard',
      { preHandler: [fastify.authenticateOperator] },
      (request) => ({ operator_id: request.operator_id, operator_role: request.operator_role }),
    );
    try {
      const token = jwt.sign(
        { operator_id: 'some-uuid', role: 'operator' },
        process.env.OPERATOR_JWT_SECRET!,
        { expiresIn: 3600 },
      );
      const res = await fastify.inject({
        method: 'GET',
        url: '/test-op-auth-guard',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ operator_id: string; operator_role: string }>();
      expect(body.operator_id).toBe('some-uuid');
      expect(body.operator_role).toBe('operator');
    } finally {
      await fastify.close();
    }
  });

  it('missing Authorization header → 401 "Invalid or expired token"', async () => {
    const fastify = await buildApp();
    fastify.get('/test-op-no-header', { preHandler: [fastify.authenticateOperator] }, () => ({ ok: true }));
    try {
      const res = await fastify.inject({ method: 'GET', url: '/test-op-no-header' });
      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { message: string } }>().error.message).toBe('Invalid or expired token');
    } finally {
      await fastify.close();
    }
  });

  it('expired token → 401', async () => {
    const fastify = await buildApp();
    fastify.get('/test-op-expired', { preHandler: [fastify.authenticateOperator] }, () => ({ ok: true }));
    try {
      const token = jwt.sign(
        { operator_id: 'some-uuid', role: 'operator' },
        process.env.OPERATOR_JWT_SECRET!,
        { expiresIn: -1 },
      );
      const res = await fastify.inject({
        method: 'GET',
        url: '/test-op-expired',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await fastify.close();
    }
  });

  it('tampered signature → 401', async () => {
    const fastify = await buildApp();
    fastify.get('/test-op-tampered', { preHandler: [fastify.authenticateOperator] }, () => ({ ok: true }));
    try {
      const token = jwt.sign(
        { operator_id: 'some-uuid', role: 'operator' },
        'wrong-secret',
        { expiresIn: 3600 },
      );
      const res = await fastify.inject({
        method: 'GET',
        url: '/test-op-tampered',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await fastify.close();
    }
  });

  it('service JWT used against operator endpoint → 401 (different secret)', async () => {
    const fastify = await buildApp();
    fastify.get('/test-op-wrong-secret', { preHandler: [fastify.authenticateOperator] }, () => ({ ok: true }));
    try {
      const token = jwt.sign(
        { tenant_id: 'some-tenant', product_id: 'some-product' },
        process.env.JWT_SECRET!,
        { expiresIn: 900 },
      );
      const res = await fastify.inject({
        method: 'GET',
        url: '/test-op-wrong-secret',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await fastify.close();
    }
  });
});

// ── requireRole factory ───────────────────────────────────────────────────────

describe('requireRole() preHandler factory', () => {
  it('admin role passes requireRole("admin")', async () => {
    const fastify = await buildApp();
    fastify.get(
      '/test-require-admin',
      { preHandler: [fastify.authenticateOperator, requireRole('admin')] },
      (request) => ({ role: request.operator_role }),
    );
    try {
      const token = jwt.sign(
        { operator_id: 'some-uuid', role: 'admin' },
        process.env.OPERATOR_JWT_SECRET!,
        { expiresIn: 3600 },
      );
      const res = await fastify.inject({
        method: 'GET',
        url: '/test-require-admin',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ role: string }>().role).toBe('admin');
    } finally {
      await fastify.close();
    }
  });

  it('operator role blocked by requireRole("admin") → 403 Forbidden', async () => {
    const fastify = await buildApp();
    fastify.get(
      '/test-require-admin-blocked',
      { preHandler: [fastify.authenticateOperator, requireRole('admin')] },
      () => ({ ok: true }),
    );
    try {
      const token = jwt.sign(
        { operator_id: 'some-uuid', role: 'operator' },
        process.env.OPERATOR_JWT_SECRET!,
        { expiresIn: 3600 },
      );
      const res = await fastify.inject({
        method: 'GET',
        url: '/test-require-admin-blocked',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: { message: string } }>().error.message).toBe('Forbidden');
    } finally {
      await fastify.close();
    }
  });

  it('/operator/auth/token is not behind JWT guard', async () => {
    const fastify = await buildApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/operator/auth/token',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'no-such-operator', password: 'x' }),
      });
      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { message: string } }>().error.message).toBe('Invalid credentials');
    } finally {
      await fastify.close();
    }
  });
});
