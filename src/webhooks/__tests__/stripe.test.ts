// Authorized by HUB-188 — unit tests for POST /webhooks/stripe HMAC verification
// Authorized by HUB-189 — idempotency: INSERT-on-conflict deduplication; status lifecycle
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Stripe mock ───────────────────────────────────────────────────────────────
const mockConstructEvent = vi.fn();
vi.mock('stripe', () => ({
  default: vi.fn().mockImplementation(() => ({
    webhooks: { constructEvent: mockConstructEvent },
  })),
}));

// ── Redis mock (rate-limit plugin needs it) ───────────────────────────────────
vi.mock('../../redis/client.js', () => ({
  getRedisClient: vi.fn().mockReturnValue({
    ping: vi.fn().mockResolvedValue('PONG'),
    incr: vi.fn().mockResolvedValue(1),
    pexpire: vi.fn().mockResolvedValue(1),
    status: 'ready',
  }),
  isRedisConnected: vi.fn().mockReturnValue(true),
  closeRedis: vi.fn(),
}));

// ── DB pool mock — controlled per-test via mockQuery ─────────────────────────
const mockQuery = vi.fn();
vi.mock('../../db/pool.js', () => ({
  getPool: vi.fn().mockReturnValue({ query: mockQuery }),
  closePool: vi.fn(),
}));

// ── Stripe event queue mock ───────────────────────────────────────────────────
const mockQueueAdd = vi.fn().mockResolvedValue({ id: 'job-1' });
vi.mock('../../queues/index.js', () => ({
  getStripeEventQueue: vi.fn().mockReturnValue({ add: mockQueueAdd }),
  getBatchSweepQueue: vi.fn(),
  getLicenseCheckQueue: vi.fn(),
  getDlqQueue: vi.fn(),
  getAllQueueDefinitions: vi.fn().mockReturnValue([]),
  registerQueue: vi.fn(),
}));

// ── Logger mock ───────────────────────────────────────────────────────────────
vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), debug: vi.fn() },
}));

// Default DB responses: INSERT returns a new row; UPDATE returns nothing.
// Both helpers reset the mock first so "once" queues from beforeEach don't bleed across tests.
function mockDbNewEvent() {
  mockQuery.mockReset();
  mockQuery
    .mockResolvedValueOnce({ rows: [{ id: 'webhook-row-1' }] }) // INSERT RETURNING id
    .mockResolvedValue({ rows: [] }); // UPDATE status
}

function mockDbDuplicate() {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] }); // INSERT ON CONFLICT returns empty
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = 'sk_test_hub188';
  process.env.STRIPE_WEBHOOK_SIGNING_SECRET = 'whsec_test_hub188';
  process.env.JWT_SECRET = 'test-secret';
  process.env.OPERATOR_JWT_SECRET = 'test-operator-secret';
  process.env.DATABASE_URL = 'postgresql://hub:hub@localhost:5432/hub_test';
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.BCRYPT_ROUNDS = '1';
  process.env.CORS_ORIGINS = 'http://localhost:3000';
  // Default: treat every event as new
  mockDbNewEvent();
});

afterEach(() => {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SIGNING_SECRET;
});

async function buildTestApp() {
  const { _resetStripeClient } = await import('../../stripe/client.js');
  _resetStripeClient();
  const { buildApp } = await import('../../app.js');
  return buildApp();
}

// ── HMAC verification (HUB-188) ───────────────────────────────────────────────

describe('POST /webhooks/stripe — signature verification', () => {
  it('returns 400 when Stripe-Signature header is missing', async () => {
    const app = await buildTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      payload: JSON.stringify({ id: 'evt_test', type: 'customer.created' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toBe('Invalid signature');
    await app.close();
  });

  it('returns 400 when signature verification fails (tampered body)', async () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature for payload');
    });

    const app = await buildTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      payload: JSON.stringify({ tampered: true }),
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 't=12345,v1=invalidsig',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toBe('Invalid signature');
    await app.close();
  });

  it('does not expose secrets or stack traces on signature failure', async () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error('Internal error');
    });

    const app = await buildTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      payload: '{}',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'bad' },
    });

    const text = res.payload;
    expect(text).not.toContain('whsec_');
    expect(text).not.toContain('stack');
    expect(res.json<{ error: { message: string } }>().error.message).toBe('Invalid signature');
    await app.close();
  });

  it('passes rawBody Buffer (not parsed JSON) to constructEvent', async () => {
    mockConstructEvent.mockReturnValue({ id: 'evt_raw', type: 'invoice.paid', data: { object: {} } });

    const app = await buildTestApp();

    await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      payload: JSON.stringify({ id: 'evt_raw' }),
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=sig' },
    });

    expect(mockConstructEvent).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.any(String),
      'whsec_test_hub188',
    );
    await app.close();
  });
});

// ── Idempotency (HUB-189) ─────────────────────────────────────────────────────

describe('POST /webhooks/stripe — idempotency', () => {
  it('returns 200 and enqueues job when event is new', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_new_1',
      type: 'customer.subscription.created',
      data: { object: { metadata: { product_id: 'prod-abc' } } },
    });

    const app = await buildTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      payload: '{}',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'valid' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ received: boolean }>().received).toBe(true);
    // Queue job was dispatched
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'process-stripe-event',
      expect.objectContaining({ eventId: 'evt_new_1', eventType: 'customer.subscription.created' }),
    );
    await app.close();
  });

  it('returns 200 immediately on duplicate event_id without dispatching a job', async () => {
    // Override beforeEach's new-event setup — ON CONFLICT returns empty (duplicate)
    mockDbDuplicate();
    mockConstructEvent.mockReturnValue({
      id: 'evt_dup',
      type: 'invoice.paid',
      data: { object: {} },
    });

    const app = await buildTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      payload: '{}',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'valid' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockQueueAdd).not.toHaveBeenCalled();
    await app.close();
  });

  it('sets status=failed and processed_at when enqueue throws', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_fail',
      type: 'charge.failed',
      data: { object: {} },
    });
    mockQueueAdd.mockRejectedValueOnce(new Error('Redis down'));

    const app = await buildTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      payload: '{}',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'valid' },
    });

    // Still returns 200 — prevents Stripe retry storm
    expect(res.statusCode).toBe(200);

    // Status update to 'failed' was attempted
    const updateCall = mockQuery.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes("status = 'failed'"),
    );
    expect(updateCall).toBeDefined();
    await app.close();
  });

  it('extracts product_id from event.data.object.metadata', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_meta',
      type: 'customer.created',
      data: { object: { metadata: { product_id: 'prod-xyz' } } },
    });

    const app = await buildTestApp();

    await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      payload: '{}',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'valid' },
    });

    // INSERT called with product_id='prod-xyz'
    const insertCall = mockQuery.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('ON CONFLICT'),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![1]).toContain('prod-xyz');
    await app.close();
  });

  it('stores product_id=null when metadata is absent', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_no_meta',
      type: 'customer.created',
      data: { object: {} },
    });

    const app = await buildTestApp();

    await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      payload: '{}',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'valid' },
    });

    const insertCall = mockQuery.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('ON CONFLICT'),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![1][2]).toBeNull();
    await app.close();
  });
});

// ── Startup validation (HUB-188) ─────────────────────────────────────────────

describe('validateStripeEnv() — STRIPE_WEBHOOK_SIGNING_SECRET', () => {
  it('exits with 1 when STRIPE_WEBHOOK_SIGNING_SECRET is absent', async () => {
    delete process.env.STRIPE_WEBHOOK_SIGNING_SECRET;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    const { _resetStripeClient, validateStripeEnv } = await import('../../stripe/client.js');
    _resetStripeClient();
    validateStripeEnv();

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
