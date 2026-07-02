// Authorized by HUB-1660 (E-FE-6 S1) — admin settings PUT-route tests.
// Locks the FR-011 contract: type-mismatched known keys return 422 with
// the catalog error inline; unknown keys pass through so the FE JSON
// fallback stays functional.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const mockGetSettings = vi.hoisted(() => vi.fn());
const mockUpdateSetting = vi.hoisted(() => vi.fn());
vi.mock('../../../services/adminSettings.js', () => ({
  getSettings: mockGetSettings,
  updateSetting: mockUpdateSetting,
}));

import adminSettingsRoutes from '../settings.js';
import { AppError } from '../../../errors/AppError.js';

let app: FastifyInstance;

function build(role: 'super_admin' | 'product_admin' = 'super_admin') {
  const instance = Fastify();
  instance.addHook('onRequest', (request, _reply, done) => {
    (request as unknown as { operatorUser: unknown }).operatorUser = {
      operator_id: 'op-1',
      role,
      tenant_id: null,
    };
    done();
  });
  instance.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: err.message });
    }
    return reply.status(500).send({ error: 'internal' });
  });
  return instance;
}

beforeAll(async () => {
  app = build();
  await app.register(adminSettingsRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PUT /api/v1/admin/settings (HUB-1660)', () => {
  it('type-mismatched known key returns 422 with the catalog error inline', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings',
      payload: { key: 'portfolio_margin_threshold_pct', value: 'not-a-number' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/expects number/);
    expect(mockUpdateSetting).not.toHaveBeenCalled();
  });

  it('type-matched known key passes through to updateSetting', async () => {
    mockUpdateSetting.mockResolvedValueOnce({
      key: 'portfolio_margin_threshold_pct',
      value: 0.05,
    });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings',
      payload: { key: 'portfolio_margin_threshold_pct', value: 0.05 },
    });
    expect(res.statusCode).toBe(200);
    expect(mockUpdateSetting).toHaveBeenCalledWith(
      'portfolio_margin_threshold_pct',
      0.05,
    );
  });

  it('unknown key with arbitrary value passes through (FR-011)', async () => {
    mockUpdateSetting.mockResolvedValueOnce({
      key: 'unknown_future_key',
      value: { anything: true },
    });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings',
      payload: { key: 'unknown_future_key', value: { anything: true } },
    });
    expect(res.statusCode).toBe(200);
    expect(mockUpdateSetting).toHaveBeenCalledWith(
      'unknown_future_key',
      { anything: true },
    );
  });

  it('product_admin is 403 (settings are super_admin-only)', async () => {
    const scoped = build('product_admin');
    await scoped.register(adminSettingsRoutes);
    await scoped.ready();
    const res = await scoped.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings',
      payload: { key: 'portfolio_margin_threshold_pct', value: 0.05 },
    });
    expect(res.statusCode).toBe(403);
    await scoped.close();
  });

  it('missing key returns 400', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings',
      payload: { value: 0.05 },
    });
    expect(res.statusCode).toBe(400);
    expect(mockUpdateSetting).not.toHaveBeenCalled();
  });
});
