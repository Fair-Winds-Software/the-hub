// Deterministic Claude Code prompt generator. Produces the copy-ready markdown a
// super_admin hands to Claude Code inside the target codebase to scaffold the HUB
// integration end-to-end.
//
// Two paths — retrofit and greenfield — with canonical templates at
// docs/hub-integration/RETROFIT.md and docs/hub-integration/GREENFIELD.md. Editing
// those files is what changes the emitted prompt; the code here only substitutes
// per-registration placeholders (product name, credentials, HUB URL, metric list).
//
// Determinism contract: buildOnboardingPrompt(input) with identical inputs and
// unchanged template files MUST return byte-identical output. The SHA-256 checksum
// returned alongside the prompt lets the frontend prove the copied text matches
// what was previewed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';

// Local copy of the metric name list — kept in sync manually with:
//   * src/services/bi/metricCatalog.ts (backend SSoT for HUB-1785)
//   * packages/hub-sdk/src/metrics/catalog.ts (SDK-side type surface)
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
  internal_only: METRIC_NAMES.filter(
    (n) => n !== 'mrr_cents' && n !== 'churn_rate',
  ),
  workbench: METRIC_NAMES.filter((n) => n !== 'mrr_cents'),
  ai_service: METRIC_NAMES,
};

function metricsFor(productType: string | null | undefined): readonly string[] {
  if (!productType) return METRIC_NAMES;
  const known = productType as ProductType;
  return PRODUCT_TYPE_METRIC_MAP[known] ?? METRIC_NAMES;
}

// ── Template loading ──────────────────────────────────────────────────────────
//
// Templates live at repo-root docs/hub-integration/*.md so they double as the
// canonical human-readable reference. Loaded once per process; each request just
// substitutes placeholders.

export type CodebaseState = 'retrofit' | 'greenfield';

const DOCS_DIR = path.resolve(process.cwd(), 'docs', 'hub-integration');

let _cachedTemplates: Record<CodebaseState, string> | null = null;

function loadTemplates(): Record<CodebaseState, string> {
  if (_cachedTemplates) return _cachedTemplates;
  const retrofit = fs.readFileSync(path.join(DOCS_DIR, 'RETROFIT.md'), 'utf8');
  const greenfield = fs.readFileSync(path.join(DOCS_DIR, 'GREENFIELD.md'), 'utf8');
  _cachedTemplates = { retrofit, greenfield };
  return _cachedTemplates;
}

/** Test-only: force a re-read of the templates on the next call. */
export function _resetTemplateCacheForTest(): void {
  _cachedTemplates = null;
}

// ── Placeholder substitution ──────────────────────────────────────────────────

interface PromptContext {
  product_id: string;
  name: string;
  slug: string;
  product_type: string | null;
  client_id: string;
  client_secret: string;
  hub_url: string;
}

function renderPrompt(
  ctx: PromptContext,
  codebase_state: CodebaseState,
): string {
  const template = loadTemplates()[codebase_state];
  const metrics = metricsFor(ctx.product_type);
  const metricsBlock = metrics.map((m) => `  - ${m}`).join('\n');
  const productTypeLine = ctx.product_type ?? '(unset — treated as full-catalog)';

  const replacements: Record<string, string> = {
    '{{PRODUCT_ID}}': ctx.product_id,
    '{{PRODUCT_NAME}}': ctx.name,
    '{{PRODUCT_SLUG}}': ctx.slug,
    '{{PRODUCT_TYPE}}': productTypeLine,
    '{{HUB_BASE_URL}}': ctx.hub_url,
    '{{HUB_CLIENT_ID}}': ctx.client_id,
    '{{HUB_CLIENT_SECRET}}': ctx.client_secret,
    '{{METRICS_BLOCK}}': metricsBlock,
  };

  let out = template;
  for (const [key, value] of Object.entries(replacements)) {
    // Global replace — placeholder may appear in the code block AND in the intro.
    out = out.split(key).join(value);
  }
  return out;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface BuildOnboardingPromptInput {
  product_id: string;
  client_id: string;
  client_secret: string;
  /** Base URL the target app should hit — defaults to env var. */
  hub_url?: string;
  /**
   * Which template to render. 'greenfield' assumes a fresh LaunchKit scaffold;
   * 'retrofit' assumes an existing app with its own auth/pricing/metrics code and
   * adds inventory + PAUSE steps before any deletion.
   * Defaults to 'greenfield' for backward compatibility with pre-refactor callers.
   */
  codebase_state?: CodebaseState;
}

export interface BuildOnboardingPromptResult {
  prompt: string;
  /** SHA-256 hex of the prompt body — frontend can prove copy matches preview. */
  checksum: string;
  /** Which template was rendered — echoed back so the caller can log / audit. */
  codebase_state: CodebaseState;
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

  const codebase_state: CodebaseState = input.codebase_state ?? 'greenfield';
  if (codebase_state !== 'retrofit' && codebase_state !== 'greenfield') {
    throw new AppError(
      400,
      `codebase_state must be 'retrofit' or 'greenfield' (got '${codebase_state}')`,
    );
  }

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

  const prompt = renderPrompt(
    {
      product_id: product.id,
      name: product.name,
      slug: product.slug,
      product_type: product.product_type,
      client_id: input.client_id,
      client_secret: input.client_secret,
      hub_url: hubUrl,
    },
    codebase_state,
  );

  const checksum = crypto.createHash('sha256').update(prompt).digest('hex');
  return { prompt, checksum, codebase_state };
}
