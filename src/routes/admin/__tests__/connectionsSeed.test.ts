// Authorized by HUB-1797 (S1 of HUB-1784) — route tests for the LLM-backed seed endpoint.
// Uses fastify.inject + injected stub LlmClient so no external calls fire. Seed façade +
// guard are mocked so tests exercise the route + service without PG.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockAssertMockMode = vi.hoisted(() => vi.fn((): void => undefined));
const mockWriteAuditEntry = vi.hoisted(() =>
  vi.fn(async (_entry: Record<string, unknown>): Promise<void> => undefined),
);
const mockFacet = vi.hoisted(() => ({
  create: vi.fn(async (items: unknown[]) => items.map((_, i) => ({ id: `id_${i}` }))),
}));
const mockReset = vi.hoisted(() => vi.fn(async (): Promise<void> => undefined));
const mockSnapshot = vi.hoisted(() =>
  vi.fn(async () => ({
    customers: 7,
    products: 2,
    prices: 2,
    coupons: 0,
    subscriptions: 7,
    invoices: 0,
    discounts: 0,
    balance_transactions: 0,
  })),
);

vi.mock('../../../stripe/seed/guard.js', () => ({ assertMockMode: mockAssertMockMode }));
vi.mock('../../../stripe/seed/index.js', () => ({
  seed: {
    customers: mockFacet,
    products: mockFacet,
    prices: mockFacet,
    coupons: mockFacet,
    subscriptions: mockFacet,
    invoices: mockFacet,
    discounts: mockFacet,
    balanceTransactions: mockFacet,
    reset: mockReset,
    snapshot: mockSnapshot,
  },
}));
vi.mock('../../../services/auditLogService.js', () => ({
  writeAuditEntry: mockWriteAuditEntry,
}));

async function buildHarness(injectedClient?: unknown) {
  const Fastify = (await import('fastify')).default;
  const routes = (await import('../connectionsSeed.js')).default;
  const app = Fastify();
  if (injectedClient) {
    (app as unknown as { llmClient: unknown }).llmClient = injectedClient;
  }
  app.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.status(status).send({ error: err.message });
  });
  await app.register(routes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/v1/admin/connections/stripe/seed/prompt', () => {
  it('returns plan_summary on happy path and writes one audit entry', async () => {
    const stubClient = {
      complete: vi.fn().mockResolvedValue({
        text: JSON.stringify({ customers: [{ email: 'a@b.co' }, { email: 'c@d.co' }] }),
        usage: { input_tokens: 1, output_tokens: 2 },
        model: 't',
      }),
    };
    const app = await buildHarness(stubClient);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/connections/stripe/seed/prompt',
      payload: { prompt: 'two customers', mode: 'add' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { plan_summary: Record<string, number>; errors: unknown[] };
    expect(body.plan_summary).toEqual({ customers: 2 });
    expect(body.errors).toEqual([]);
    expect(mockWriteAuditEntry).toHaveBeenCalledOnce();
    const auditCall = mockWriteAuditEntry.mock.calls[0]![0] as {
      new_values: { action: string; connection: string; mode: string; rows_created: number };
    };
    expect(auditCall.new_values.action).toBe('connection.seed.prompt');
    expect(auditCall.new_values.connection).toBe('stripe');
    expect(auditCall.new_values.mode).toBe('add');
    expect(auditCall.new_values.rows_created).toBe(2);
    await app.close();
  });

  it('returns 400 when prompt is missing', async () => {
    const app = await buildHarness({ complete: vi.fn() });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/connections/stripe/seed/prompt',
      payload: { mode: 'add' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 400 when mode is invalid', async () => {
    const app = await buildHarness({ complete: vi.fn() });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/connections/stripe/seed/prompt',
      payload: { prompt: 'valid prompt', mode: 'nope' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 404 for an unsupported connection name', async () => {
    const app = await buildHarness({ complete: vi.fn() });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/connections/ga/seed/prompt',
      payload: { prompt: 'valid prompt', mode: 'add' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('surfaces LLM validation failures as 400 and does NOT write an audit entry', async () => {
    const stubClient = {
      complete: vi.fn().mockResolvedValue({
        text: 'this is not JSON',
        usage: { input_tokens: 1, output_tokens: 2 },
        model: 't',
      }),
    };
    const app = await buildHarness(stubClient);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/connections/stripe/seed/prompt',
      payload: { prompt: 'valid prompt', mode: 'add' },
    });
    expect(res.statusCode).toBe(400);
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects the request when assertMockMode throws (forged call under LIVE mode)', async () => {
    // First call: entry check inside runSeedPrompt. Simulate LIVE by having the guard throw.
    mockAssertMockMode.mockImplementationOnce(() => {
      throw Object.assign(new Error('Seeding forbidden — Stripe connection is in LIVE mode'), {
        statusCode: 400,
      });
    });
    const stubClient = { complete: vi.fn() };
    const app = await buildHarness(stubClient);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/connections/stripe/seed/prompt',
      payload: { prompt: 'valid prompt', mode: 'add' },
    });
    expect(res.statusCode).toBe(400);
    expect(stubClient.complete).not.toHaveBeenCalled();
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    await app.close();
  });
});

// ── HUB-1798 (S2 of HUB-1784) — preset endpoints + DELETE-all ────────────────

describe('GET /api/v1/admin/connections/stripe/seed/presets', () => {
  it('returns the preset registry (id, label, description only)', async () => {
    const app = await buildHarness();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/connections/stripe/seed/presets',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { presets: Array<{ id: string; label: string; description: string }> };
    expect(body.presets.length).toBeGreaterThanOrEqual(3);
    const ids = body.presets.map((p) => p.id);
    expect(ids).toContain('active-customers-500');
    expect(ids).toContain('churned-mix');
    expect(ids).toContain('discount-heavy');
    for (const p of body.presets) {
      expect(typeof p.id).toBe('string');
      expect(typeof p.label).toBe('string');
      expect(typeof p.description).toBe('string');
      // Do not leak the plan itself.
      expect((p as Record<string, unknown>).plan).toBeUndefined();
    }
    await app.close();
  });
});

describe('POST /api/v1/admin/connections/stripe/seed/preset', () => {
  it('runs a preset by id and returns plan_summary + writes audit entry', async () => {
    const app = await buildHarness();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/connections/stripe/seed/preset',
      payload: { preset_id: 'active-customers-500', mode: 'add' },
    });
    expect(res.statusCode).toBe(200);
    // Facet mocks return `items.length` items — so 500 customers + 500 subscriptions + 1 product + 1 price.
    const body = JSON.parse(res.body) as { plan_summary: Record<string, number> };
    expect(body.plan_summary.customers).toBe(500);
    expect(body.plan_summary.subscriptions).toBe(500);
    expect(body.plan_summary.products).toBe(1);
    expect(body.plan_summary.prices).toBe(1);
    expect(mockWriteAuditEntry).toHaveBeenCalledOnce();
    const auditCall = mockWriteAuditEntry.mock.calls[0]![0] as {
      new_values: { action: string; preset_id: string; mode: string };
    };
    expect(auditCall.new_values.action).toBe('connection.seed.preset');
    expect(auditCall.new_values.preset_id).toBe('active-customers-500');
    expect(auditCall.new_values.mode).toBe('add');
    await app.close();
  });

  it("mode='replace' calls seed.reset() first", async () => {
    const app = await buildHarness();
    await app.inject({
      method: 'POST',
      url: '/api/v1/admin/connections/stripe/seed/preset',
      payload: { preset_id: 'discount-heavy', mode: 'replace' },
    });
    expect(mockReset).toHaveBeenCalledOnce();
    await app.close();
  });

  it('returns 400 for an unknown preset_id and does not write audit', async () => {
    const app = await buildHarness();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/connections/stripe/seed/preset',
      payload: { preset_id: 'does-not-exist', mode: 'add' },
    });
    expect(res.statusCode).toBe(400);
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 400 when preset_id is missing', async () => {
    const app = await buildHarness();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/connections/stripe/seed/preset',
      payload: { mode: 'add' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('adversarial: forged call under LIVE mode is rejected — no facet writes, no audit', async () => {
    mockAssertMockMode.mockImplementationOnce(() => {
      throw Object.assign(new Error('Seeding forbidden — Stripe connection is in LIVE mode'), {
        statusCode: 400,
      });
    });
    const app = await buildHarness();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/connections/stripe/seed/preset',
      payload: { preset_id: 'active-customers-500', mode: 'add' },
    });
    expect(res.statusCode).toBe(400);
    expect(mockFacet.create).not.toHaveBeenCalled();
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('DELETE /api/v1/admin/connections/stripe/seed', () => {
  it('wipes the mock store, returns rows_deleted from the pre-reset snapshot', async () => {
    const app = await buildHarness();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/admin/connections/stripe/seed',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { rows_deleted: number };
    // snapshot mock returns 7+2+2+0+7+0+0+0 = 18
    expect(body.rows_deleted).toBe(18);
    expect(mockSnapshot).toHaveBeenCalledOnce();
    expect(mockReset).toHaveBeenCalledOnce();
    // Snapshot must be read BEFORE reset (order matters for accurate count).
    const snapshotOrder = mockSnapshot.mock.invocationCallOrder[0]!;
    const resetOrder = mockReset.mock.invocationCallOrder[0]!;
    expect(snapshotOrder).toBeLessThan(resetOrder);
    expect(mockWriteAuditEntry).toHaveBeenCalledOnce();
    const auditCall = mockWriteAuditEntry.mock.calls[0]![0] as {
      operation: string;
      new_values: { action: string; rows_deleted: number };
    };
    expect(auditCall.operation).toBe('DELETE');
    expect(auditCall.new_values.action).toBe('connection.seed.reset');
    expect(auditCall.new_values.rows_deleted).toBe(18);
    await app.close();
  });

  it('returns 404 for an unsupported connection name', async () => {
    const app = await buildHarness();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/admin/connections/ga/seed',
    });
    expect(res.statusCode).toBe(404);
    expect(mockReset).not.toHaveBeenCalled();
    await app.close();
  });

  it('adversarial: forged call under LIVE mode is rejected — no snapshot, no reset, no audit', async () => {
    mockAssertMockMode.mockImplementationOnce(() => {
      throw Object.assign(new Error('Seeding forbidden — Stripe connection is in LIVE mode'), {
        statusCode: 400,
      });
    });
    const app = await buildHarness();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/admin/connections/stripe/seed',
    });
    expect(res.statusCode).toBe(400);
    expect(mockSnapshot).not.toHaveBeenCalled();
    expect(mockReset).not.toHaveBeenCalled();
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    await app.close();
  });
});
