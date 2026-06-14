// Authorized by HUB-174 — unit tests for Stripe SDK singleton and fail-fast validation
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('stripe', () => ({
  default: vi.fn().mockImplementation((key: string, opts: unknown) => ({
    _key: key,
    _opts: opts,
  })),
}));

vi.mock('../../lib/logger.js', () => ({
  default: { fatal: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

beforeEach(async () => {
  vi.clearAllMocks();
  delete process.env.STRIPE_SECRET_KEY;
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

  it('does not exit when STRIPE_SECRET_KEY is present', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_valid';
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    const { validateStripeEnv } = await import('../client.js');
    validateStripeEnv();

    expect(exitSpy).not.toHaveBeenCalled();
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
