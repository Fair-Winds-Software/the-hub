// Authorized by HUB-1821 (S4 of HUB-1787) — unit tests for buildOnboardingPrompt.
// Verifies determinism, checksum stability, product_type-driven metric subsets,
// 404 on unknown product, and content invariants (secret + DO NOT commit reminder).
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockPool = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('../../db/pool.js', () => ({ getPool: () => mockPool }));

const { buildOnboardingPrompt } = await import('../onboardingPromptService.js');

const PRODUCT_A = '00000000-0000-4000-8000-000000000aaa';

function stubProduct(row: { name: string; slug: string; product_type: string | null }): void {
  mockPool.query.mockImplementation(async () => ({
    rows: [{ id: PRODUCT_A, name: row.name, slug: row.slug, product_type: row.product_type }],
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildOnboardingPrompt — happy path', () => {
  it('returns a non-empty prompt + a 64-char sha256 checksum', async () => {
    stubProduct({ name: 'ContentHelm', slug: 'contenthelm', product_type: 'saas' });
    const result = await buildOnboardingPrompt({
      product_id: PRODUCT_A,
      client_id: 'test-client-id',
      client_secret: 'test-client-secret',
      hub_url: 'https://hub.test',
    });
    expect(result.prompt.length).toBeGreaterThan(200);
    expect(result.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it('embeds product name, slug, credentials, and HUB URL in the prompt', async () => {
    stubProduct({ name: 'ContentHelm', slug: 'contenthelm', product_type: 'saas' });
    const { prompt } = await buildOnboardingPrompt({
      product_id: PRODUCT_A,
      client_id: 'cid-42',
      client_secret: 'sec-42',
      hub_url: 'https://hub.example',
    });
    expect(prompt).toContain('ContentHelm');
    expect(prompt).toContain('contenthelm');
    expect(prompt).toContain('cid-42');
    expect(prompt).toContain('sec-42');
    expect(prompt).toContain('https://hub.example');
  });

  it('includes a DO NOT commit warning adjacent to the secret', async () => {
    stubProduct({ name: 'ContentHelm', slug: 'contenthelm', product_type: 'saas' });
    const { prompt } = await buildOnboardingPrompt({
      product_id: PRODUCT_A,
      client_id: 'x',
      client_secret: 'secret-value-should-warn',
      hub_url: 'https://h',
    });
    expect(prompt).toMatch(/DO NOT commit/i);
  });
});

describe('buildOnboardingPrompt — determinism + checksum', () => {
  it('same inputs → byte-identical prompt + same checksum', async () => {
    stubProduct({ name: 'ContentHelm', slug: 'contenthelm', product_type: 'saas' });
    const input = {
      product_id: PRODUCT_A,
      client_id: 'stable-id',
      client_secret: 'stable-secret',
      hub_url: 'https://stable',
    };
    const a = await buildOnboardingPrompt(input);
    const b = await buildOnboardingPrompt(input);
    expect(a.prompt).toBe(b.prompt);
    expect(a.checksum).toBe(b.checksum);
  });

  it('changing product_type changes both prompt AND checksum', async () => {
    stubProduct({ name: 'X', slug: 'x-svc', product_type: 'saas' });
    const asSaas = await buildOnboardingPrompt({
      product_id: PRODUCT_A,
      client_id: 'x',
      client_secret: 'x',
      hub_url: 'https://h',
    });
    stubProduct({ name: 'X', slug: 'x-svc', product_type: 'internal_only' });
    const asInternal = await buildOnboardingPrompt({
      product_id: PRODUCT_A,
      client_id: 'x',
      client_secret: 'x',
      hub_url: 'https://h',
    });
    expect(asSaas.prompt).not.toBe(asInternal.prompt);
    expect(asSaas.checksum).not.toBe(asInternal.checksum);
  });

  it('changing client_secret changes checksum', async () => {
    stubProduct({ name: 'X', slug: 'x-svc', product_type: 'saas' });
    const a = await buildOnboardingPrompt({
      product_id: PRODUCT_A,
      client_id: 'x',
      client_secret: 'secret-a',
      hub_url: 'https://h',
    });
    const b = await buildOnboardingPrompt({
      product_id: PRODUCT_A,
      client_id: 'x',
      client_secret: 'secret-b',
      hub_url: 'https://h',
    });
    expect(a.checksum).not.toBe(b.checksum);
  });
});

describe('buildOnboardingPrompt — metric subset per product_type', () => {
  it("saas exposes mrr_cents + churn_rate", async () => {
    stubProduct({ name: 'X', slug: 'x-svc', product_type: 'saas' });
    const { prompt } = await buildOnboardingPrompt({
      product_id: PRODUCT_A,
      client_id: 'x',
      client_secret: 'x',
      hub_url: 'https://h',
    });
    expect(prompt).toContain('mrr_cents');
    expect(prompt).toContain('churn_rate');
  });

  it("internal_only OMITS mrr_cents + churn_rate", async () => {
    stubProduct({ name: 'X', slug: 'x-svc', product_type: 'internal_only' });
    const { prompt } = await buildOnboardingPrompt({
      product_id: PRODUCT_A,
      client_id: 'x',
      client_secret: 'x',
      hub_url: 'https://h',
    });
    expect(prompt).not.toContain('mrr_cents');
    expect(prompt).not.toContain('churn_rate');
    // Sanity — other metrics still present
    expect(prompt).toContain('daily_active_users');
  });

  it('unknown product_type falls back to full catalog', async () => {
    stubProduct({ name: 'X', slug: 'x-svc', product_type: 'never-heard-of' });
    const { prompt } = await buildOnboardingPrompt({
      product_id: PRODUCT_A,
      client_id: 'x',
      client_secret: 'x',
      hub_url: 'https://h',
    });
    expect(prompt).toContain('mrr_cents');
    expect(prompt).toContain('churn_rate');
    expect(prompt).toContain('daily_active_users');
  });

  it('null product_type falls back to full catalog', async () => {
    stubProduct({ name: 'X', slug: 'x-svc', product_type: null });
    const { prompt } = await buildOnboardingPrompt({
      product_id: PRODUCT_A,
      client_id: 'x',
      client_secret: 'x',
      hub_url: 'https://h',
    });
    expect(prompt).toContain('mrr_cents');
    expect(prompt).toContain('churn_rate');
  });
});

describe('buildOnboardingPrompt — validation failures', () => {
  it('400 when client_id missing', async () => {
    stubProduct({ name: 'X', slug: 'x-svc', product_type: 'saas' });
    await expect(
      buildOnboardingPrompt({
        product_id: PRODUCT_A,
        client_id: '',
        client_secret: 'x',
        hub_url: 'https://h',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('400 when client_secret missing', async () => {
    stubProduct({ name: 'X', slug: 'x-svc', product_type: 'saas' });
    await expect(
      buildOnboardingPrompt({
        product_id: PRODUCT_A,
        client_id: 'x',
        client_secret: '',
        hub_url: 'https://h',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('404 when product does not exist', async () => {
    mockPool.query.mockImplementation(async () => ({ rows: [] }));
    await expect(
      buildOnboardingPrompt({
        product_id: PRODUCT_A,
        client_id: 'x',
        client_secret: 'x',
        hub_url: 'https://h',
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
