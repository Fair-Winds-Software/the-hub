// Authorized by HUB-1797 (S1 of HUB-1784) — unit tests for the seed prompt service.
// The seed façade and mock-mode guard are mocked here so the service is exercised without
// a live PG. Behavioral tests exercised:
//   1. happy path — LLM returns a valid SeedPlan → each facet's .create is invoked with
//      the corresponding array, plan_summary reflects the row counts.
//   2. LLM returns non-JSON → AppError(400).
//   3. LLM returns JSON that fails SeedPlan validation → AppError(400) with issue path.
//   4. mode='replace' calls seed.reset() first; mode='add' does not.
//   5. A facet .create() throwing aborts the plan and returns errors[] populated with
//      the facet key + the error message; later facets are NOT invoked.
//   6. Prompt shorter than 5 chars → 400. Longer than 4000 → 400. Invalid mode → 400.
//   7. runSeedPlan (S2 fast-path) bypasses the LLM and runs the plan directly.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AppError } from '../../errors/AppError.js';
import type { LlmClient, LlmCompletionResponse } from '../llmClient.js';

// Mock the mock-mode guard so tests don't need the connections registry populated.
vi.mock('../../stripe/seed/guard.js', () => ({
  assertMockMode: vi.fn(() => undefined),
}));

// Mock the seed façade so the service is exercised without PG.
const facetMocks = {
  customers: { create: vi.fn(async (items: unknown[]) => items.map((_, i) => ({ id: `cus_${i}` }))) },
  products: { create: vi.fn(async (items: unknown[]) => items.map((_, i) => ({ id: `prod_${i}` }))) },
  prices: { create: vi.fn(async (items: unknown[]) => items.map((_, i) => ({ id: `price_${i}` }))) },
  coupons: { create: vi.fn(async (items: unknown[]) => items.map((_, i) => ({ id: `cpn_${i}` }))) },
  subscriptions: { create: vi.fn(async (items: unknown[]) => items.map((_, i) => ({ id: `sub_${i}` }))) },
  invoices: { create: vi.fn(async (items: unknown[]) => items.map((_, i) => ({ id: `inv_${i}` }))) },
  discounts: { create: vi.fn(async (items: unknown[]) => items.map((_, i) => ({ id: `disc_${i}` }))) },
  balanceTransactions: { create: vi.fn(async (items: unknown[]) => items.map((_, i) => ({ id: `bt_${i}` }))) },
};
const resetMock = vi.fn(async () => undefined);
vi.mock('../../stripe/seed/index.js', () => ({
  seed: {
    customers: facetMocks.customers,
    products: facetMocks.products,
    prices: facetMocks.prices,
    coupons: facetMocks.coupons,
    subscriptions: facetMocks.subscriptions,
    invoices: facetMocks.invoices,
    discounts: facetMocks.discounts,
    balanceTransactions: facetMocks.balanceTransactions,
    reset: resetMock,
    snapshot: vi.fn(),
  },
}));

// Import service AFTER mocks are declared.
const { runSeedPrompt, runSeedPlan } = await import('../seedPromptService.js');

function makeClient(response: string): LlmClient {
  return {
    async complete(): Promise<LlmCompletionResponse> {
      return { text: response, usage: { input_tokens: 10, output_tokens: 20 }, model: 'test' };
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runSeedPrompt — happy path', () => {
  it('dispatches each facet in the plan and returns a plan_summary', async () => {
    const plan = {
      customers: [{ email: 'a@b.co' }, { email: 'c@d.co' }],
      products: [{ name: 'Plan A' }],
    };
    const client = makeClient(JSON.stringify(plan));
    const result = await runSeedPrompt({ prompt: 'two customers, one product', mode: 'add', client });
    expect(facetMocks.customers.create).toHaveBeenCalledWith(plan.customers);
    expect(facetMocks.products.create).toHaveBeenCalledWith(plan.products);
    expect(result.plan_summary).toEqual({ customers: 2, products: 1 });
    expect(result.errors).toEqual([]);
    expect(resetMock).not.toHaveBeenCalled();
  });

  it("tolerates a fenced-JSON response (```json ... ```)", async () => {
    const plan = { customers: [{ email: 'a@b.co' }] };
    const client = makeClient('```json\n' + JSON.stringify(plan) + '\n```');
    const result = await runSeedPrompt({ prompt: 'one customer', mode: 'add', client });
    expect(result.plan_summary).toEqual({ customers: 1 });
  });

  it("mode='replace' calls seed.reset() before executing", async () => {
    const client = makeClient(JSON.stringify({ customers: [{ email: 'a@b.co' }] }));
    await runSeedPrompt({ prompt: 'one customer, wipe first', mode: 'replace', client });
    expect(resetMock).toHaveBeenCalledOnce();
  });
});

describe('runSeedPrompt — validation errors', () => {
  it('rejects a prompt under 5 chars', async () => {
    const client = makeClient('{}');
    await expect(
      runSeedPrompt({ prompt: 'hi', mode: 'add', client }),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('at least 5') });
  });

  it('rejects a prompt over 4000 chars', async () => {
    const client = makeClient('{}');
    await expect(
      runSeedPrompt({ prompt: 'x'.repeat(4001), mode: 'add', client }),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('under 4000') });
  });

  it("rejects an invalid mode", async () => {
    const client = makeClient('{}');
    await expect(
      runSeedPrompt({ prompt: 'valid prompt', mode: 'nope' as never, client }),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("'add'") });
  });

  it('rejects a non-JSON LLM response with 400', async () => {
    const client = makeClient('This is not JSON, just prose.');
    await expect(
      runSeedPrompt({ prompt: 'valid prompt', mode: 'add', client }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('not valid JSON'),
    });
  });

  it('rejects a JSON response that does not match SeedPlan (top-level array)', async () => {
    const client = makeClient(JSON.stringify(['not', 'the', 'schema']));
    await expect(
      runSeedPrompt({ prompt: 'valid prompt', mode: 'add', client }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('did not match the SeedPlan schema'),
    });
  });

  it('rejects a plan where a facet is not an array', async () => {
    const client = makeClient(JSON.stringify({ customers: 'not an array' }));
    await expect(
      runSeedPrompt({ prompt: 'valid prompt', mode: 'add', client }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('runSeedPrompt — facet failure aborts the plan', () => {
  it('when customers.create throws, later facets are not invoked and errors[] is populated', async () => {
    facetMocks.customers.create.mockRejectedValueOnce(new AppError(400, 'row 1: email is required'));
    const plan = {
      customers: [{ email: 'ok@b.co' }, {}],
      products: [{ name: 'never runs' }],
    };
    const client = makeClient(JSON.stringify(plan));
    const result = await runSeedPrompt({ prompt: 'valid prompt', mode: 'add', client });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.facet).toBe('customers');
    expect(result.errors[0]!.message).toContain('row 1');
    expect(facetMocks.products.create).not.toHaveBeenCalled();
    expect(result.plan_summary.products).toBeUndefined();
  });
});

describe('runSeedPlan — S2 fast-path (no LLM)', () => {
  it('runs a pre-validated plan directly', async () => {
    const result = await runSeedPlan(
      { customers: [{ email: 'a@b.co' }], products: [{ name: 'P' }] },
      'add',
    );
    expect(facetMocks.customers.create).toHaveBeenCalled();
    expect(facetMocks.products.create).toHaveBeenCalled();
    expect(result.plan_summary).toEqual({ customers: 1, products: 1 });
  });

  it("mode='replace' calls seed.reset() first", async () => {
    await runSeedPlan({ customers: [{ email: 'a@b.co' }] }, 'replace');
    expect(resetMock).toHaveBeenCalledOnce();
  });
});
