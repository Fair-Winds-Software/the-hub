// Authorized by HUB-1821 (S4 of HUB-1787) — deterministic Claude Code prompt generator.
// Produces the copy-ready markdown a super_admin hands to Claude Code inside the target
// codebase to scaffold the HUB integration end-to-end.
//
// Determinism contract: buildOnboardingPrompt(input) with identical (productId, name,
// slug, product_type, client_id, client_secret, hub_url) MUST return byte-identical
// output. The SHA-256 checksum returned alongside the prompt lets the frontend prove
// the copied text matches what was previewed.
//
// Design notes:
//   * Prompt template is a plain interpolated string (no templating engine — YAGNI).
//   * Metric subset per product_type is a small explicit map so authoring a new type
//     is a Story-scoped decision. Unknown / null → all metrics (safe default).
//   * client_secret is inlined into the prompt at generation time (that's the whole
//     point of the prompt — it's a copy-paste bootstrap). A "DO NOT commit" reminder
//     lives adjacent to the secret in the template.
import crypto from 'node:crypto';
import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';

// Local copy of the metric name list — kept in sync manually with:
//   * src/services/bi/metricCatalog.ts (backend SSoT for HUB-1785)
//   * packages/hub-sdk/src/metrics/catalog.ts (SDK-side type surface)
// Adding a metric means updating all three. A drift-detection smoke test could
// be a follow-up if this becomes error-prone.
const METRIC_NAMES = [
  'daily_active_users',
  'logins',
  'mrr_cents',
  'churn_rate',
  'feature_adoption',
  'app_health_status',
] as const;

// ── Metric subset per product_type ────────────────────────────────────────────

type ProductType = 'saas' | 'internal_only' | 'workbench' | 'ai_service';

const PRODUCT_TYPE_METRIC_MAP: Record<ProductType, readonly string[]> = {
  saas: METRIC_NAMES,
  // Internal apps don't have MRR / churn — Fair Winds employees are not billed.
  internal_only: METRIC_NAMES.filter(
    (n) => n !== 'mrr_cents' && n !== 'churn_rate',
  ),
  // Dev tools (e.g. VDF Workbench) have no billing.
  workbench: METRIC_NAMES.filter((n) => n !== 'mrr_cents'),
  ai_service: METRIC_NAMES,
};

function metricsFor(productType: string | null | undefined): readonly string[] {
  if (!productType) return METRIC_NAMES;
  const known = productType as ProductType;
  return PRODUCT_TYPE_METRIC_MAP[known] ?? METRIC_NAMES;
}

// ── Prompt template ───────────────────────────────────────────────────────────

interface PromptContext {
  product_id: string;
  name: string;
  slug: string;
  product_type: string | null;
  client_id: string;
  client_secret: string;
  hub_url: string;
}

function renderPrompt(ctx: PromptContext): string {
  const metrics = metricsFor(ctx.product_type);
  const metricsBlock = metrics.map((m) => `  - ${m}`).join('\n');
  const productTypeLine = ctx.product_type ?? '(unset — treated as full-catalog)';
  return `# Wire this codebase to HUB — ${ctx.name}

You are Claude Code, working inside the ${ctx.name} repository. Your mission: wire this application to HUB so it can push BI metrics and check entitlements.

## HUB registration (already done by the operator)

- **product_id**: \`${ctx.product_id}\`
- **slug**: \`${ctx.slug}\`
- **product_type**: \`${productTypeLine}\`
- **HUB base URL**: \`${ctx.hub_url}\`

## Credentials (⚠️ DO NOT commit these to git)

Add to \`.env.local\` (or your platform's secret store) and add matching entries to \`.env.example\` with EMPTY values only:

\`\`\`
HUB_BASE_URL=${ctx.hub_url}
HUB_CLIENT_ID=${ctx.client_id}
HUB_CLIENT_SECRET=${ctx.client_secret}
\`\`\`

**⚠️ IMMEDIATE ACTION:** Confirm \`.env.local\` is listed in \`.gitignore\` BEFORE writing the secret. If it isn't, stop and add it first.

## Install the SDK

\`\`\`
npm install @maverick-launch/hub-sdk
\`\`\`

## Bootstrap the HubClient

Create \`src/hub/client.ts\`:

\`\`\`ts
import { HubClient, MetricsClient } from '@maverick-launch/hub-sdk';

const hub = new HubClient({
  clientId: process.env.HUB_CLIENT_ID!,
  clientSecret: process.env.HUB_CLIENT_SECRET!,
  hubUrl: process.env.HUB_BASE_URL!,
});

// Reuse HubClient's auth pipeline for metric push authentication.
const metrics = new MetricsClient({
  hubUrl: process.env.HUB_BASE_URL!,
  getBearerToken: async () => {
    // MetricsClient wants a bearer token; HubClient handles refresh internally.
    // Simplest bridge: expose HubClient's ping() so we know it's connected, then
    // call the internal token surface. For production, expose a method on
    // HubClient itself and consume it here.
    await hub.connect();
    // Assumes HubClient exposes an accessor; add one if not.
    return (hub as unknown as { token: string }).token;
  },
});

metrics.startFlushLoop();

export { hub, metrics };
\`\`\`

## Push your first metric

The HUB metric catalog for a \`${productTypeLine}\` product exposes these names — pushing any name outside this list is silently dropped by HUB and audited:

${metricsBlock}

Example daily-active-users push (place at your app's DAU-computation site):

\`\`\`ts
import { metrics } from './hub/client';

// e.g. at end-of-day cron or when session count is finalized
metrics.push('daily_active_users', 500);
\`\`\`

## Verify

1. Run the app; watch its logs to confirm the HubClient connects (no 401 from POST /api/v1/auth/token).
2. In the HUB Console, open \`/console/products/${ctx.product_id}/bi\` and confirm your metric appears within ~15 min (rolls up on the hourly boundary).

## Test-run checklist before you claim done

- [ ] \`npm test\` — no new failures introduced by hub/client.ts
- [ ] App logs show one successful connect + one successful ping to HUB
- [ ] At least one metric is visible in the HUB BI dashboard for this product
`;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface BuildOnboardingPromptInput {
  product_id: string;
  client_id: string;
  client_secret: string;
  /** Base URL the target app should hit — defaults to env var. */
  hub_url?: string;
}

export interface BuildOnboardingPromptResult {
  prompt: string;
  /** SHA-256 hex of the prompt body — frontend can prove copy matches preview. */
  checksum: string;
}

interface ProductRow {
  id: string;
  name: string;
  slug: string;
  product_type: string | null;
}

export async function buildOnboardingPrompt(
  input: BuildOnboardingPromptInput,
): Promise<BuildOnboardingPromptResult> {
  if (!input.product_id) throw new AppError(400, 'product_id is required');
  if (!input.client_id) throw new AppError(400, 'client_id is required');
  if (!input.client_secret) throw new AppError(400, 'client_secret is required');

  const hubUrl = input.hub_url ?? process.env['HUB_PUBLIC_BASE_URL'] ?? 'http://localhost:3000';

  const pool = getPool();
  const { rows } = await pool.query<ProductRow>(
    `SELECT id::text, name, slug, (metadata->>'product_type') AS product_type
       FROM products WHERE id = $1::uuid`,
    [input.product_id],
  );
  if (rows.length === 0) {
    throw new AppError(404, `Unknown product '${input.product_id}'`);
  }
  const product = rows[0]!;

  const prompt = renderPrompt({
    product_id: product.id,
    name: product.name,
    slug: product.slug,
    product_type: product.product_type,
    client_id: input.client_id,
    client_secret: input.client_secret,
    hub_url: hubUrl,
  });

  const checksum = crypto.createHash('sha256').update(prompt).digest('hex');
  return { prompt, checksum };
}
