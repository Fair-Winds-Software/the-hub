// Authorized by HUB-174 — unit tests for Stripe SDK singleton and fail-fast validation
// Authorized by HUB-188 — updated to cover STRIPE_WEBHOOK_SIGNING_SECRET validation
// Authorized by HUB-413 — getStripe(), stripeIdempotencyKey(), mapStripeError()
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('stripe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('stripe')>();
  const MockStripe = vi.fn().mockImplementation((key: string, opts: unknown) => ({
    _key: key,
    _opts: opts,
  }));
  // Preserve static error classes so mapStripeError instanceof checks work in tests
  (MockStripe as unknown as Record<string, unknown>).errors = actual.default.errors;
  return { default: MockStripe };
});

vi.mock('../../lib/logger.js', () => ({
  default: { fatal: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

beforeEach(async () => {
  vi.clearAllMocks();
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SIGNING_SECRET;
  // Reset singleton between tests
  const { _resetStripeClient } = await import('../client.js');
  _resetStripeClient();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('validateStripeEnv()', () => {
  it('calls process.exit(1) when STRIPE_SECRET_KEY is absent', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    const { validateStripeEnv } = await import('../client.js');
    validateStripeEnv();

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('does not include the key value in the fatal log message', async () => {
    const logger = await import('../../lib/logger.js');
    const fatalSpy = vi.spyOn(logger.default, 'fatal');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    const { validateStripeEnv } = await import('../client.js');
    validateStripeEnv();

    expect(fatalSpy).toHaveBeenCalled();
    const logArg = fatalSpy.mock.calls[0][0] as string;
    expect(logArg).toMatch(/missing/i);
    expect(logArg).not.toMatch(/sk_/);

    exitSpy.mockRestore();
  });

  it('does not exit when both STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SIGNING_SECRET are present', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_valid';
    process.env.STRIPE_WEBHOOK_SIGNING_SECRET = 'whsec_test_valid';
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    const { validateStripeEnv } = await import('../client.js');
    validateStripeEnv();

    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('exits with 1 when STRIPE_WEBHOOK_SIGNING_SECRET is absent', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_valid';
    // STRIPE_WEBHOOK_SIGNING_SECRET intentionally absent
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    const { validateStripeEnv } = await import('../client.js');
    validateStripeEnv();

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

describe('getStripeClient()', () => {
  it('returns the same instance on successive calls (===)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_singleton';

    const { getStripeClient } = await import('../client.js');
    const first = getStripeClient();
    const second = getStripeClient();

    expect(first).toBe(second);
  });

  it('initializes with a fixed apiVersion, not "latest"', async () => {
    const Stripe = (await import('stripe')).default;
    process.env.STRIPE_SECRET_KEY = 'sk_test_version';

    const { getStripeClient } = await import('../client.js');
    getStripeClient();

    expect(Stripe).toHaveBeenCalledWith(
      'sk_test_version',
      expect.objectContaining({ apiVersion: expect.stringMatching(/^\d{4}-\d{2}-\d{2}/) }),
    );
  });

  it('exits with 1 when key is missing on first call', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    const { getStripeClient } = await import('../client.js');
    getStripeClient();

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

// ── getStripe() ───────────────────────────────────────────────────────────────

describe('getStripe()', () => {
  it('throws AppError(500) when STRIPE_SECRET_KEY is absent', async () => {
    const { getStripe } = await import('../client.js');
    expect(() => getStripe()).toThrow(expect.objectContaining({ statusCode: 500 }));
  });

  it('returns a client when STRIPE_SECRET_KEY is present', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_getStripe';
    const { getStripe } = await import('../client.js');
    const client = getStripe();
    expect(client).toBeDefined();
  });

  it('returns the same singleton instance as getStripeClient()', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_shared';
    const { getStripe, getStripeClient } = await import('../client.js');
    expect(getStripe()).toBe(getStripeClient());
  });
});

// ── stripeIdempotencyKey() ────────────────────────────────────────────────────

describe('stripeIdempotencyKey()', () => {
  it('joins parts with colon', async () => {
    const { stripeIdempotencyKey } = await import('../client.js');
    expect(stripeIdempotencyKey('create-sub', 'tenant-1', 'product-1')).toBe(
      'create-sub:tenant-1:product-1',
    );
  });

  it('is deterministic — same parts produce same key', async () => {
    const { stripeIdempotencyKey } = await import('../client.js');
    const k1 = stripeIdempotencyKey('op', 'a', 'b');
    const k2 = stripeIdempotencyKey('op', 'a', 'b');
    expect(k1).toBe(k2);
  });

  it('different parts produce different keys', async () => {
    const { stripeIdempotencyKey } = await import('../client.js');
    expect(stripeIdempotencyKey('op', 'a')).not.toBe(stripeIdempotencyKey('op', 'b'));
  });

  it('truncates output to 255 characters', async () => {
    const { stripeIdempotencyKey } = await import('../client.js');
    const key = stripeIdempotencyKey('x'.repeat(300));
    expect(key.length).toBeLessThanOrEqual(255);
  });
});

// ── mapStripeError() ──────────────────────────────────────────────────────────

describe('mapStripeError()', () => {
  let mapStripeError: (err: unknown) => never;

  beforeEach(async () => {
    const mod = await import('../client.js');
    mapStripeError = mod.mapStripeError;
  });

  it('maps StripeCardError to AppError(402)', async () => {
    const Stripe = (await import('stripe')).default;
    const err = new Stripe.errors.StripeCardError({ message: 'card declined', type: 'card_error' });
    expect(() => mapStripeError(err)).toThrow(expect.objectContaining({ statusCode: 402 }));
  });

  it('maps StripeInvalidRequestError to AppError(400)', async () => {
    const Stripe = (await import('stripe')).default;
    const err = new Stripe.errors.StripeInvalidRequestError({ message: 'bad param', type: 'invalid_request_error' });
    expect(() => mapStripeError(err)).toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  it('maps StripeRateLimitError to AppError(429)', async () => {
    const Stripe = (await import('stripe')).default;
    const err = new Stripe.errors.StripeRateLimitError({ message: 'rate limited', type: 'invalid_request_error' });
    expect(() => mapStripeError(err)).toThrow(expect.objectContaining({ statusCode: 429 }));
  });

  it('re-throws non-Stripe errors unchanged', async () => {
    const plain = new Error('something else');
    expect(() => mapStripeError(plain)).toThrow(plain);
  });
});
