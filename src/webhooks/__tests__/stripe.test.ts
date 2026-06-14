// Authorized by HUB-188 — unit tests for POST /webhooks/stripe HMAC verification
// Authorized by HUB-189 — idempotency: INSERT-on-conflict deduplication; status lifecycle
// Authorized by HUB-202 — event-type fan-out routing; DLQ fallback for null product_id / unknown types
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

// ── Queue mocks (HUB-202: fan-out routing) ───────────────────────────────────
const mockQueueAdd = vi.fn().mockResolvedValue({ id: 'job-1' });
const mockQueue = { add: mockQueueAdd };
vi.mock('../../queues/index.js', () => ({
  // HUB-202 routing helpers
  getQueueForEventType: vi.fn().mockReturnValue(mockQueue),
  hasQueueForEventType: vi.fn().mockReturnValue(false), // no specific queues registered by default
  getDlqQueue: vi.fn().mockReturnValue(mockQueue),
  // Legacy / other queues (kept for compat — stripe.ts no longer imports getStripeEventQueue)
  getStripeEventQueue: vi.fn().mockReturnValue(mockQueue),
  getBatchSweepQueue: vi.fn(),
  getLicenseCheckQueue: vi.fn(),
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
    .mockResolvedValueOnce({ rows: [{ id: 'webhook-row-1', received_at: new Date('2026-01-01T00:00:00Z') }] }) // INSERT RETURNING id, received_at
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
    // Queue job was dispatched with snake_case payload (HUB-202 AC2)
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'process-stripe-event',
      expect.objectContaining({ event_id: 'evt_new_1', event_type: 'customer.subscription.created' }),
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

// ── Event routing (HUB-202) ──────────────────────────────────────────────────

describe('POST /webhooks/stripe — event routing (HUB-202)', () => {
  it('routes null product_id to DLQ and emits warn', async () => {
    const logger = await import('../../lib/logger.js');
    const warnSpy = vi.spyOn(logger.default, 'warn');

    mockConstructEvent.mockReturnValue({
      id: 'evt_dlq_null',
      type: 'customer.created',
      data: { object: {} }, // no metadata → product_id = null
    });

    const app = await buildTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      payload: '{}',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'valid' },
    });

    expect(res.statusCode).toBe(200);
    // getDlqQueue should have been called, not getQueueForEventType
    const { getDlqQueue } = await import('../../queues/index.js');
    expect(getDlqQueue).toHaveBeenCalled();
    // Warn emitted with event context
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event_id: 'evt_dlq_null' }),
      expect.stringContaining('product_id absent'),
    );
    await app.close();
  });

  it('routes unrecognized event type to DLQ and emits warn when product_id is present', async () => {
    const logger = await import('../../lib/logger.js');
    const warnSpy = vi.spyOn(logger.default, 'warn');

    mockConstructEvent.mockReturnValue({
      id: 'evt_dlq_type',
      type: 'unknown.event.type',
      data: { object: { metadata: { product_id: 'prod-abc' } } },
    });
    // hasQueueForEventType returns false by default (no factories registered in tests)

    const app = await buildTestApp();

    await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      payload: '{}',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'valid' },
    });

    const { getDlqQueue } = await import('../../queues/index.js');
    expect(getDlqQueue).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event_id: 'evt_dlq_type' }),
      expect.stringContaining('unrecognized event type'),
    );
    await app.close();
  });

  it('routes to specific queue when hasQueueForEventType returns true', async () => {
    const { hasQueueForEventType, getQueueForEventType } = await import('../../queues/index.js');
    vi.mocked(hasQueueForEventType).mockReturnValue(true);

    mockConstructEvent.mockReturnValue({
      id: 'evt_specific',
      type: 'invoice.payment_succeeded',
      data: { object: { metadata: { product_id: 'prod-abc' } } },
    });

    const app = await buildTestApp();

    await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      payload: '{}',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'valid' },
    });

    expect(getQueueForEventType).toHaveBeenCalledWith('invoice.payment_succeeded');
    await app.close();
  });

  it('job payload is snake_case, includes received_at, excludes raw_event', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_payload',
      type: 'customer.subscription.created',
      data: { object: { metadata: { product_id: 'prod-payload' } } },
    });

    const app = await buildTestApp();

    await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      payload: '{}',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'valid' },
    });

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'process-stripe-event',
      expect.objectContaining({
        event_id: 'evt_payload',
        event_type: 'customer.subscription.created',
        product_id: 'prod-payload',
        received_at: expect.any(String),
      }),
    );
    // raw_event must NOT be in the payload
    const payload = mockQueueAdd.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('raw_event');
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
