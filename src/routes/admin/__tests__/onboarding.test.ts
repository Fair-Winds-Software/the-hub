// Authorized by HUB-1818 (S1 of HUB-1787) — route tests for POST /admin/onboarding/register.
// Service is mocked; verifies RBAC + validation + delegation + 201 shape.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockRegisterProduct = vi.hoisted(() =>
  vi.fn(async () => ({
    product_id: '00000000-0000-4000-8000-000000000aaa',
    slug: 'contenthelm',
    name: 'ContentHelm',
    client_id: '00000000-0000-4000-8000-000000000ccc',
    client_secret: 'plaintext-secret-returned-once',
  })),
);
const mockRotateCredential = vi.hoisted(() =>
  vi.fn(async () => ({
    product_id: '00000000-0000-4000-8000-000000000aaa',
    slug: 'contenthelm',
    client_id: '00000000-0000-4000-8000-000000000ccc',
    client_secret: 'new-plaintext-secret',
  })),
);
const mockRevokeProduct = vi.hoisted(() =>
  vi.fn(async () => ({
    product_id: '00000000-0000-4000-8000-000000000aaa',
    slug: 'contenthelm',
    active: false as const,
    effective_hard_revoke_at: '2026-07-15T21:00:00.000Z',
  })),
);

const mockBuildOnboardingPrompt = vi.hoisted(() =>
  vi.fn(async () => ({
    prompt: '# Wire this codebase to HUB',
    checksum: 'a'.repeat(64),
  })),
);

vi.mock('../../../services/onboardingService.js', () => ({
  registerProduct: mockRegisterProduct,
  rotateCredential: mockRotateCredential,
  revokeProduct: mockRevokeProduct,
}));
vi.mock('../../../services/onboardingPromptService.js', () => ({
  buildOnboardingPrompt: mockBuildOnboardingPrompt,
}));

async function buildHarness(role?: 'super_admin' | 'product_admin') {
  const Fastify = (await import('fastify')).default;
  const routes = (await import('../onboarding.js')).default;
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.status(status).send({ error: err.message });
  });
  if (role) {
    app.addHook('onRequest', async (req) => {
      (req as unknown as { operator: { role: string; operator_id: string } }).operator = {
        role,
        operator_id: 'op-1',
      };
    });
  }
  await app.register(routes);
  return app;
}

const VALID_BODY = {
  tenant_id: '00000000-0000-4000-8000-00000000eeaa',
  name: 'ContentHelm',
  slug: 'contenthelm',
  product_type: 'saas',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/v1/admin/onboarding/register — RBAC', () => {
  it('403 without operator', async () => {
    const app = await buildHarness();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/onboarding/register',
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(403);
    expect(mockRegisterProduct).not.toHaveBeenCalled();
    await app.close();
  });

  it('403 for product_admin', async () => {
    const app = await buildHarness('product_admin');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/onboarding/register',
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('201 for super_admin', async () => {
    const app = await buildHarness('super_admin');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/onboarding/register',
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { product_id: string; client_id: string; client_secret: string };
    expect(body.client_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.client_secret).toBe('plaintext-secret-returned-once');
    await app.close();
  });
});

describe('POST /api/v1/admin/onboarding/register — request validation', () => {
  it('400 when tenant_id missing', async () => {
    const app = await buildHarness('super_admin');
    const { tenant_id: _t, ...rest } = VALID_BODY;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/onboarding/register',
      payload: rest,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400 when name missing', async () => {
    const app = await buildHarness('super_admin');
    const { name: _n, ...rest } = VALID_BODY;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/onboarding/register',
      payload: rest,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400 when slug missing', async () => {
    const app = await buildHarness('super_admin');
    const { slug: _s, ...rest } = VALID_BODY;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/onboarding/register',
      payload: rest,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400 when product_type is not a string', async () => {
    const app = await buildHarness('super_admin');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/onboarding/register',
      payload: { ...VALID_BODY, product_type: 42 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('passes actor_operator_id from the request operator context', async () => {
    const app = await buildHarness('super_admin');
    await app.inject({
      method: 'POST',
      url: '/api/v1/admin/onboarding/register',
      payload: VALID_BODY,
    });
    const call = mockRegisterProduct.mock.calls[0]![0] as { actor_operator_id: string };
    expect(call.actor_operator_id).toBe('op-1');
    await app.close();
  });
});

// ── HUB-1819 (S2 of HUB-1787) — rotate + revoke route tests ──────────────────

const PRODUCT_URL_ID = '00000000-0000-4000-8000-000000000aaa';

describe('POST /admin/onboarding/:productId/rotate-credential', () => {
  it('403 without operator', async () => {
    const app = await buildHarness();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/onboarding/${PRODUCT_URL_ID}/rotate-credential`,
      payload: { reason: 'x' },
    });
    expect(res.statusCode).toBe(403);
    expect(mockRotateCredential).not.toHaveBeenCalled();
    await app.close();
  });

  it('403 for product_admin', async () => {
    const app = await buildHarness('product_admin');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/onboarding/${PRODUCT_URL_ID}/rotate-credential`,
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('200 for super_admin — returns new plaintext client_secret', async () => {
    const app = await buildHarness('super_admin');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/onboarding/${PRODUCT_URL_ID}/rotate-credential`,
      payload: { reason: 'quarterly' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { client_id: string; client_secret: string };
    expect(body.client_secret).toBe('new-plaintext-secret');
    expect(mockRotateCredential).toHaveBeenCalledOnce();
    const call = mockRotateCredential.mock.calls[0]![0] as { product_id: string; reason?: string };
    expect(call.product_id).toBe(PRODUCT_URL_ID);
    expect(call.reason).toBe('quarterly');
    await app.close();
  });

  it('400 when reason is not a string', async () => {
    const app = await buildHarness('super_admin');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/onboarding/${PRODUCT_URL_ID}/rotate-credential`,
      payload: { reason: 42 },
    });
    expect(res.statusCode).toBe(400);
    expect(mockRotateCredential).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('POST /admin/onboarding/:productId/prompt', () => {
  it('403 without operator', async () => {
    const app = await buildHarness();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/onboarding/${PRODUCT_URL_ID}/prompt`,
      payload: { client_id: 'x', client_secret: 'y' },
    });
    expect(res.statusCode).toBe(403);
    expect(mockBuildOnboardingPrompt).not.toHaveBeenCalled();
    await app.close();
  });

  it('403 for product_admin', async () => {
    const app = await buildHarness('product_admin');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/onboarding/${PRODUCT_URL_ID}/prompt`,
      payload: { client_id: 'x', client_secret: 'y' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('200 for super_admin — returns prompt + checksum', async () => {
    const app = await buildHarness('super_admin');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/onboarding/${PRODUCT_URL_ID}/prompt`,
      payload: { client_id: 'cid-42', client_secret: 'sec-42', hub_url: 'https://h' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { prompt: string; checksum: string };
    expect(body.checksum).toMatch(/^[a-f0-9]{64}$/);
    const call = mockBuildOnboardingPrompt.mock.calls[0]![0] as {
      product_id: string;
      client_id: string;
      client_secret: string;
      hub_url: string;
    };
    expect(call.product_id).toBe(PRODUCT_URL_ID);
    expect(call.client_id).toBe('cid-42');
    expect(call.client_secret).toBe('sec-42');
    expect(call.hub_url).toBe('https://h');
    await app.close();
  });

  it('400 when client_id missing', async () => {
    const app = await buildHarness('super_admin');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/onboarding/${PRODUCT_URL_ID}/prompt`,
      payload: { client_secret: 'y' },
    });
    expect(res.statusCode).toBe(400);
    expect(mockBuildOnboardingPrompt).not.toHaveBeenCalled();
    await app.close();
  });

  it('400 when client_secret missing', async () => {
    const app = await buildHarness('super_admin');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/onboarding/${PRODUCT_URL_ID}/prompt`,
      payload: { client_id: 'x' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('POST /admin/onboarding/:productId/revoke', () => {
  it('403 without operator', async () => {
    const app = await buildHarness();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/onboarding/${PRODUCT_URL_ID}/revoke`,
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(mockRevokeProduct).not.toHaveBeenCalled();
    await app.close();
  });

  it('200 for super_admin — returns hard-revoke deadline', async () => {
    const app = await buildHarness('super_admin');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/onboarding/${PRODUCT_URL_ID}/revoke`,
      payload: { reason: 'billing lapse' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { active: boolean; effective_hard_revoke_at: string };
    expect(body.active).toBe(false);
    expect(body.effective_hard_revoke_at).toBeTypeOf('string');
    expect(mockRevokeProduct).toHaveBeenCalledOnce();
    const call = mockRevokeProduct.mock.calls[0]![0] as { product_id: string; reason?: string };
    expect(call.product_id).toBe(PRODUCT_URL_ID);
    expect(call.reason).toBe('billing lapse');
    await app.close();
  });

  it('400 when reason is not a string', async () => {
    const app = await buildHarness('super_admin');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/onboarding/${PRODUCT_URL_ID}/revoke`,
      payload: { reason: { nested: true } },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
