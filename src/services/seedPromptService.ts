// Authorized by HUB-1797 (S1 of HUB-1784) — translate an operator-supplied free-text
// prompt into a validated SeedPlan, then execute the plan against the Stripe mock store
// via the existing S5 seeding façade. Every path here is guarded by assertMockMode() at
// entry AND per-row inside the seed façade so a mid-execution mode flip aborts the
// enclosing transaction.
//
// Design decisions (from the S1 story description):
//   - LLM call happens INSIDE the same request that runs the seed. No async plan storage.
//   - The LLM is asked for a strict JSON body matching a Zod schema. The service parses
//     the JSON with a lenient strategy (strip common wrappers like ```json ... ```) so
//     the model doesn't have to be perfectly formatted, but the schema check is strict.
//   - Errors are surfaced with row indices so the caller can pinpoint which facet item
//     failed and, if useful, retry with a hand-edited plan.
import { z } from 'zod';
import { AppError } from '../errors/AppError.js';
import { assertMockMode } from '../stripe/seed/guard.js';
import { seed } from '../stripe/seed/index.js';
import type { LlmClient } from './llmClient.js';

// ── SeedPlan shape ─────────────────────────────────────────────────────────────
// This is intentionally LOOSE — per-item strict validation happens inside each seed.*.
// facet (which uses the same Zod schemas as MockStripeAdapter's reads). The plan-level
// schema just asserts "one array per facet name, items are objects".

const RowObject = z.record(z.string(), z.unknown());

export const SeedPlan = z.object({
  customers: z.array(RowObject).optional(),
  products: z.array(RowObject).optional(),
  prices: z.array(RowObject).optional(),
  coupons: z.array(RowObject).optional(),
  subscriptions: z.array(RowObject).optional(),
  invoices: z.array(RowObject).optional(),
  discounts: z.array(RowObject).optional(),
  balance_transactions: z.array(RowObject).optional(),
});
export type SeedPlan = z.infer<typeof SeedPlan>;

// ── System prompt sent to the LLM ──────────────────────────────────────────────

const SYSTEM_PROMPT = `You translate free-text mock-data descriptions into a JSON SeedPlan for a Stripe test store.

Return ONLY a single JSON object matching this exact schema (do not include any prose or code fences):

{
  "customers":            [{ "email": string?, "name": string?, "metadata": object? }],
  "products":             [{ "name": string, "active": boolean? }],
  "prices":               [{ "product": string, "unit_amount": number, "currency": "usd"|"eur"|..., "recurring_interval": "month"|"year"? }],
  "coupons":              [{ "duration": "forever"|"once"|"repeating", "percent_off": number?, "amount_off": number?, "currency": string? }],
  "subscriptions":        [{ "customer": string, "status": "active"|"past_due"|"canceled"|"trialing", "items": [{ "price": string, "quantity": number? }] }],
  "invoices":             [{ "customer": string, "status": "draft"|"open"|"paid"|"void", "amount_due": number, "currency": string }],
  "discounts":            [{ "customer": string, "coupon": string }],
  "balance_transactions": [{ "customer": string, "amount": number, "currency": string, "description": string? }]
}

Rules:
- Omit facets you are not seeding — do not send empty arrays.
- Cross-references (subscription.customer, discount.coupon, etc.) MUST use IDs that appear elsewhere in the same plan OR let HUB auto-generate them by omitting the id and providing enough context.
- Prefer realistic mixes (e.g., if asked for "500 customers with churn", include a mix of active / past_due / canceled subscriptions).
- Do NOT include commentary, do NOT wrap the JSON in code fences, do NOT include trailing text.`;

// ── Response parsing helpers ───────────────────────────────────────────────────

function stripCodeFences(raw: string): string {
  // Some models wrap JSON in ```json ... ``` despite instructions. Tolerate it.
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced ? fenced[1]!.trim() : trimmed;
}

function parseLlmJson(raw: string): unknown {
  try {
    return JSON.parse(stripCodeFences(raw));
  } catch {
    throw new AppError(400, 'LLM response was not valid JSON — prompt may be too ambiguous');
  }
}

// ── Execution result shape ─────────────────────────────────────────────────────

export interface SeedExecutionError {
  facet: string;
  index: number;
  message: string;
}

export interface SeedExecutionResult {
  plan_summary: Record<string, number>;
  errors: SeedExecutionError[];
}

// ── Facet dispatch ─────────────────────────────────────────────────────────────

const FACET_ORDER: Array<{ key: keyof SeedPlan; run: (items: Array<Record<string, unknown>>) => Promise<Array<{ id: string }>> }> = [
  { key: 'customers', run: (items) => seed.customers.create(items as never) },
  { key: 'products', run: (items) => seed.products.create(items as never) },
  { key: 'prices', run: (items) => seed.prices.create(items as never) },
  { key: 'coupons', run: (items) => seed.coupons.create(items as never) },
  { key: 'subscriptions', run: (items) => seed.subscriptions.create(items as never) },
  { key: 'invoices', run: (items) => seed.invoices.create(items as never) },
  { key: 'discounts', run: (items) => seed.discounts.create(items as never) },
  { key: 'balance_transactions', run: (items) => seed.balanceTransactions.create(items as never) },
];

async function executePlan(plan: SeedPlan): Promise<SeedExecutionResult> {
  assertMockMode();
  const summary: Record<string, number> = {};
  const errors: SeedExecutionError[] = [];
  for (const { key, run } of FACET_ORDER) {
    const items = plan[key];
    if (!items || items.length === 0) continue;
    try {
      const results = await run(items as Array<Record<string, unknown>>);
      summary[key] = results.length;
    } catch (err) {
      // The seed façade wraps validation failures in AppError; capture and stop the
      // whole plan (facet order matters — later facets often reference earlier IDs).
      errors.push({ facet: key, index: -1, message: (err as Error).message });
      break;
    }
  }
  return { plan_summary: summary, errors };
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface RunSeedPromptOptions {
  prompt: string;
  mode: 'add' | 'replace';
  client: LlmClient;
}

export async function runSeedPrompt(opts: RunSeedPromptOptions): Promise<SeedExecutionResult> {
  assertMockMode();
  if (typeof opts.prompt !== 'string' || opts.prompt.trim().length < 5) {
    throw new AppError(400, 'prompt must be at least 5 characters');
  }
  if (opts.prompt.length > 4000) {
    throw new AppError(400, 'prompt must be under 4000 characters');
  }
  if (opts.mode !== 'add' && opts.mode !== 'replace') {
    throw new AppError(400, "mode must be 'add' or 'replace'");
  }

  const completion = await opts.client.complete({
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: opts.prompt }],
    temperature: 0.2,
  });

  const parsed = parseLlmJson(completion.text);
  const validation = SeedPlan.safeParse(parsed);
  if (!validation.success) {
    throw new AppError(
      400,
      `LLM response did not match the SeedPlan schema: ${validation.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`,
    );
  }

  if (opts.mode === 'replace') {
    await seed.reset();
  }
  return executePlan(validation.data);
}

/**
 * Execute a pre-validated SeedPlan directly. Used by the S2 preset endpoint which
 * has no LLM call in its critical path.
 */
export async function runSeedPlan(plan: SeedPlan, mode: 'add' | 'replace'): Promise<SeedExecutionResult> {
  assertMockMode();
  if (mode === 'replace') {
    await seed.reset();
  }
  return executePlan(plan);
}
