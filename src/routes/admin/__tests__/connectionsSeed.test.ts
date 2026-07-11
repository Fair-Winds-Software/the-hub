// Authorized by HUB-1797 (S1 of HUB-1784) — route tests for the LLM-backed seed endpoint.
// Uses fastify.inject + injected stub LlmClient so no external calls fire. Seed façade +
// guard are mocked so tests exercise the route + service without PG.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockAssertMockMode = vi.hoisted(() => vi.fn(() => undefined));
const mockWriteAuditEntry = vi.hoisted(() => vi.fn(async () => undefined));
const mockFacet = vi.hoisted(() => ({
  create: vi.fn(async (items: unknown[]) => items.map((_, i) => ({ id: `id_${i}` }))),
}));

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
    reset: vi.fn(async () => undefined),
    snapshot: vi.fn(),
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
