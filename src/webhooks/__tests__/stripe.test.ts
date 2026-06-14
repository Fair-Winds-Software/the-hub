// Authorized by HUB-188 — unit tests for POST /webhooks/stripe HMAC verification
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Stripe mock ───────────────────────────────────────────────────────────────
const mockConstructEvent = vi.fn();
const mockGenerateTestHeaderString = vi.fn();

vi.mock('stripe', () => ({
  default: vi.fn().mockImplementation(() => ({
    webhooks: {
      constructEvent: mockConstructEvent,
      generateTestHeaderString: mockGenerateTestHeaderString,
    },
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

// ── DB pool mock ──────────────────────────────────────────────────────────────
vi.mock('../../db/pool.js', () => ({
  getPool: vi.fn().mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [] }) }),
  closePool: vi.fn(),
}));

// ── Logger mock ───────────────────────────────────────────────────────────────
vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), debug: vi.fn() },
}));

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

describe('POST /webhooks/stripe', () => {
  it('returns 400 when Stripe-Signature header is missing', async () => {
    const app = await buildTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      payload: JSON.stringify({ id: 'evt_test', type: 'customer.created' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { code: number; message: string } }>();
    expect(body.error.message).toBe('Invalid signature');
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

  it('returns 200 when signature is valid', async () => {
    const fakeEvent = { id: 'evt_valid', type: 'customer.subscription.created', data: {} };
    mockConstructEvent.mockReturnValue(fakeEvent);

    const app = await buildTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      payload: JSON.stringify({ id: 'evt_valid', type: 'customer.subscription.created' }),
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 't=12345,v1=validsig',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ received: boolean; type: string }>();
    expect(body.received).toBe(true);
    expect(body.type).toBe('customer.subscription.created');
    await app.close();
  });

  it('does not expose stack traces or internal detail on signature failure', async () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error('Internal Stripe error with secret details');
    });

    const app = await buildTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      payload: '{}',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 'bad',
      },
    });

    const text = res.payload;
    expect(text).not.toContain('whsec_');
    expect(text).not.toContain('stack');
    expect(res.json<{ error: { message: string } }>().error.message).toBe('Invalid signature');
    await app.close();
  });

  it('passes rawBody Buffer to constructEvent, not the parsed JSON string', async () => {
    const fakeEvent = { id: 'evt_raw', type: 'invoice.paid', data: {} };
    mockConstructEvent.mockReturnValue(fakeEvent);

    const app = await buildTestApp();
    const payload = JSON.stringify({ id: 'evt_raw' });

    await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      payload,
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 't=1,v1=sig',
      },
    });

    expect(mockConstructEvent).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.any(String),
      'whsec_test_hub188',
    );
    await app.close();
  });
});

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
