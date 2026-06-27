// Authorized by HUB-1600 (E-BE-1 S17) — p95 latency baseline for the 3 new HUB-1556
// endpoints per §9 NFR-Performance. Single regression-net perf test that runs in the
// standard `npm test` cycle, writes a JSON trend artifact to qa-results/perf/hub1556.json,
// and asserts both spec budgets (200ms / 500ms / 1000ms) and tighter mocked-path
// regression budgets (25ms across the board with mocked services).
//
// Strategy deviations (documented):
// 1. Mocked-path perf, not real-DB perf. Spec asked for autocannon/k6 against fixture-
//    seeded Postgres + Redis. HUB has no existing perf-test harness (no autocannon dep,
//    no qa-results/ tree, no separate CI job). Resolution: Fastify.inject + vitest +
//    process.hrtime.bigint() for ns precision. Measures code-path overhead — catches
//    "someone added blocking work to the handler" regressions. Real-DB perf testing
//    feeds /qa-baseline at Stage 4 L1 (story spec acknowledges this).
// 2. Test path src/__tests__/... (HUB code root is src/, not backend/).
// 3. JSON artifact path qa-results/perf/hub1556.json — matches spec; directory created
//    on demand via mkdirSync({recursive:true}).
// 4. R1 cache-hit FIX: jira tickets perf measured against `{available:true,...}` mocked
//    response only. Degraded path `{available:false,...}` measured in a second describe
//    block — recorded under cache_hit_degraded_p95 but does NOT gate.
// 5. CI separate-job wiring deferred to /harden Stage 4.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const mockPoolQuery = vi.hoisted(() => vi.fn());
vi.mock('../db/pool.js', () => ({ getPool: () => ({ query: mockPoolQuery }) }));

const mockWriteAuditEntry = vi.hoisted(() => vi.fn());
vi.mock('../services/auditLogService.js', () => ({
  writeAuditEntry: mockWriteAuditEntry,
}));

const mockGetTicketCounts = vi.hoisted(() => vi.fn());
const mockClearAuthCache = vi.hoisted(() => vi.fn());
vi.mock('../services/jiraIntegrationService.js', () => ({
  getTicketCounts: mockGetTicketCounts,
  clearAuthCache: mockClearAuthCache,
}));

const mockGetPortfolioMargin = vi.hoisted(() => vi.fn());
const mockFetchScenarioBaseline = vi.hoisted(() => vi.fn());
const mockComputeScenario = vi.hoisted(() => vi.fn());
vi.mock('../services/analyticsService.js', () => ({
  getPortfolioMargin: mockGetPortfolioMargin,
  fetchScenarioBaseline: mockFetchScenarioBaseline,
  computeScenario: mockComputeScenario,
  getUsageAnalytics: vi.fn(),
  getBillingAnalytics: vi.fn(),
}));

vi.mock('../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import analyticsRoutes from '../routes/analyticsRoutes.js';
import adminIntegrationRoutes from '../routes/admin/integrations.js';
import { AppError } from '../errors/AppError.js';

const SECRET = 'test-secret-hub-1600';
const PRODUCT = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const N = 100;

// Spec budgets (HUB-1556 §9 NFR-Performance)
const SPEC_BUDGET_JIRA_MS = 200;
const SPEC_BUDGET_PORTFOLIO_MS = 500;
const SPEC_BUDGET_SCENARIO_MS = 1000;
// Mocked-path regression budgets (catches handler-bloat regressions before they hit
// the loose spec budgets). 25ms is generous on modern CI runners with vitest startup
// and mock overhead included.
const REGRESSION_BUDGET_MS = 25;

function token() {
  return jwt.sign(
    { operator_id: 'op-1', role: 'super_admin', tenant_id: null },
    SECRET,
    { expiresIn: '1h' },
  );
}
function authHeader() {
  return { authorization: `Bearer ${token()}`, 'content-type': 'application/json' };
}

interface PercentileSummary {
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  max_ms: number;
  iterations: number;
}

function percentiles(samplesNs: bigint[]): PercentileSummary {
  const sortedMs = samplesNs
    .map((ns) => Number(ns) / 1_000_000)
    .sort((a, b) => a - b);
  const pickIdx = (q: number) => Math.min(sortedMs.length - 1, Math.floor(q * sortedMs.length));
  return {
    p50_ms: round3(sortedMs[pickIdx(0.5)]!),
    p95_ms: round3(sortedMs[pickIdx(0.95)]!),
    p99_ms: round3(sortedMs[pickIdx(0.99)]!),
    max_ms: round3(sortedMs[sortedMs.length - 1]!),
    iterations: sortedMs.length,
  };
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

async function measure(
  app: FastifyInstance,
  buildPayload: () => Parameters<FastifyInstance['inject']>[0],
  iterations: number,
): Promise<{ percentiles: PercentileSummary; lastStatus: number }> {
  // Warmup — one untimed call lets V8 JIT compile the hot path before measurement.
  await app.inject(buildPayload());

  const samples: bigint[] = new Array(iterations);
  let lastStatus = 0;
  for (let i = 0; i < iterations; i++) {
    const t0 = process.hrtime.bigint();
    const res = await app.inject(buildPayload());
    const t1 = process.hrtime.bigint();
    samples[i] = t1 - t0;
    lastStatus = res.statusCode;
  }
  return { percentiles: percentiles(samples), lastStatus };
}

interface EndpointResult {
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  max_ms: number;
  iterations: number;
  spec_budget_ms: number;
  regression_budget_ms: number;
  spec_gate: 'pass' | 'fail';
  regression_gate: 'pass' | 'fail';
}

function toEndpointResult(
  pct: PercentileSummary,
  specBudgetMs: number,
): EndpointResult {
  return {
    ...pct,
    spec_budget_ms: specBudgetMs,
    regression_budget_ms: REGRESSION_BUDGET_MS,
    spec_gate: pct.p95_ms < specBudgetMs ? 'pass' : 'fail',
    regression_gate: pct.p95_ms < REGRESSION_BUDGET_MS ? 'pass' : 'fail',
  };
}

// Build one Fastify app per route plugin (matches the production registration pattern;
// each app gets its own setErrorHandler so AppError → status mapping is consistent).
async function buildIsolatedApp(plugin: typeof analyticsRoutes): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: err.message });
    return reply.status(500).send({ error: 'internal' });
  });
  await app.register(plugin);
  await app.ready();
  return app;
}

let analyticsApp: FastifyInstance;
let integrationsApp: FastifyInstance;

const results: Record<string, EndpointResult | { p95_ms: number; gated: false; iterations: number }> = {};

beforeAll(async () => {
  process.env.OPERATOR_JWT_SECRET = SECRET;
  analyticsApp = await buildIsolatedApp(analyticsRoutes);
  integrationsApp = await buildIsolatedApp(adminIntegrationRoutes);
});

afterAll(async () => {
  // Write the trend artifact AFTER all `it` blocks have populated `results`.
  // mkdirSync({recursive:true}) is a no-op if the directory already exists.
  const dir = resolve(process.cwd(), 'qa-results/perf');
  mkdirSync(dir, { recursive: true });
  const artifact = {
    story: 'HUB-1600 (E-BE-1 S17)',
    timestamp: new Date().toISOString(),
    iterations_per_endpoint: N,
    harness: 'mocked-services (vitest + fastify.inject; hrtime.bigint precision)',
    note: 'Mocked-path measurements isolate handler/routing/serialization overhead. Real-DB perf testing feeds /qa-baseline at Stage 4 L1.',
    endpoints: results,
  };
  writeFileSync(
    resolve(dir, 'hub1556.json'),
    JSON.stringify(artifact, null, 2) + '\n',
    'utf8',
  );

  await analyticsApp.close();
  await integrationsApp.close();
});

describe('HUB-1600 — HUB-1556 endpoint p95 latency baselines (§9 NFR-Performance)', () => {
  describe('GET /api/v1/admin/integrations/jira/tickets — cache-hit, available:true (R1 FIX)', () => {
    it(`p95 < ${SPEC_BUDGET_JIRA_MS}ms (spec budget) AND < ${REGRESSION_BUDGET_MS}ms (mocked-path regression budget) across ${N} iterations`, async () => {
      // R1 FIX: the cache-hit perf budget is measured against the successful-counts
      // response only. Mock returns instantly to simulate a populated Redis cache hit
      // (the route never touches the network because getTicketCounts is mocked).
      mockGetTicketCounts.mockResolvedValue({
        available: true,
        openCRs: 3,
        openBugs: 7,
        lastSyncedAt: new Date('2026-06-27T00:00:00Z').toISOString(),
      });

      const { percentiles: pct, lastStatus } = await measure(
        integrationsApp,
        () => ({
          method: 'GET',
          url: `/api/v1/admin/integrations/jira/tickets?productId=${PRODUCT}`,
          headers: authHeader(),
        }),
        N,
      );

      expect(lastStatus).toBe(200);
      results.jira_tickets_cache_hit = toEndpointResult(pct, SPEC_BUDGET_JIRA_MS);

      expect(pct.p95_ms).toBeLessThan(SPEC_BUDGET_JIRA_MS);
      expect(pct.p95_ms).toBeLessThan(REGRESSION_BUDGET_MS);
    });
  });

  describe('GET /api/v1/admin/integrations/jira/tickets — cache-hit, available:false (R1 observability only)', () => {
    it(`records cache_hit_degraded_p95 across ${N} iterations — NOT gated`, async () => {
      mockGetTicketCounts.mockResolvedValue({
        available: false,
        reason: 'upstream_unavailable',
      });

      const { percentiles: pct, lastStatus } = await measure(
        integrationsApp,
        () => ({
          method: 'GET',
          url: `/api/v1/admin/integrations/jira/tickets?productId=${PRODUCT}`,
          headers: authHeader(),
        }),
        N,
      );

      // The route always returns 200 with the {available:false} body per the R1
      // cross-Epic contract; just record the p95, don't gate.
      expect(lastStatus).toBe(200);
      results.jira_tickets_cache_hit_degraded = {
        p95_ms: pct.p95_ms,
        iterations: pct.iterations,
        gated: false,
      };
    });
  });

  describe('GET /api/v1/analytics/portfolio-margin', () => {
    it(`p95 < ${SPEC_BUDGET_PORTFOLIO_MS}ms (spec budget) AND < ${REGRESSION_BUDGET_MS}ms (mocked-path regression budget) across ${N} iterations`, async () => {
      mockGetPortfolioMargin.mockResolvedValue({
        from: '2026-05-01T00:00:00.000Z',
        to: '2026-05-31T23:59:59.000Z',
        generatedAt: new Date().toISOString(),
        threshold: 0.0,
        products: [],
        portfolio: { revenueCents: 0, costCents: 0, marginPct: null, losingMoney: false },
      });

      const { percentiles: pct, lastStatus } = await measure(
        analyticsApp,
        () => ({
          method: 'GET',
          url: '/api/v1/analytics/portfolio-margin?from=2026-05-01&to=2026-05-31',
          headers: authHeader(),
        }),
        N,
      );

      expect(lastStatus).toBe(200);
      results.portfolio_margin = toEndpointResult(pct, SPEC_BUDGET_PORTFOLIO_MS);

      expect(pct.p95_ms).toBeLessThan(SPEC_BUDGET_PORTFOLIO_MS);
      expect(pct.p95_ms).toBeLessThan(REGRESSION_BUDGET_MS);
    });
  });

  describe('POST /api/v1/analytics/pricing-scenario', () => {
    it(`p95 < ${SPEC_BUDGET_SCENARIO_MS}ms (spec budget) AND < ${REGRESSION_BUDGET_MS}ms (mocked-path regression budget) across ${N} iterations`, async () => {
      // pricing_models pre-check always returns 1 row (cache the same result for all N).
      mockPoolQuery.mockResolvedValue({ rows: [{ id: 'pm-active' }] });
      mockFetchScenarioBaseline.mockResolvedValue({
        snapshotAt: '2026-06-27T00:00:00.000Z',
        productId: PRODUCT,
        revenueLast30dCents: 100_000,
        costLast30dCents: 40_000,
        subscriptionCount: 100,
        elasticityCoefficient: -1.0,
        marginPct: 0.6,
      });
      mockComputeScenario.mockReturnValue({
        baseline: {
          snapshotAt: '2026-06-27T00:00:00.000Z',
          productId: PRODUCT,
          revenueLast30dCents: 100_000,
          costLast30dCents: 40_000,
          subscriptionCount: 100,
          elasticityCoefficient: -1.0,
          marginPct: 0.6,
        },
        scenario: { revenueCents: 99_000, costCents: 40_000, marginPct: 0.5959, subscriptionCount: 90 },
        delta: { revenueCents: -1_000, costCents: 0, marginPctPoints: -0.0041, subscriptionCount: -10 },
        modelType: 'constant_elasticity',
        disclaimer: 'advisory',
      });
      mockWriteAuditEntry.mockResolvedValue(undefined);

      const { percentiles: pct, lastStatus } = await measure(
        analyticsApp,
        () => ({
          method: 'POST',
          url: '/api/v1/analytics/pricing-scenario',
          headers: authHeader(),
          payload: {
            product_id: PRODUCT,
            baseline_model_id: 'pm-active',
            price_change_percent: 10,
            churn_assumption_percent: 5,
          },
        }),
        N,
      );

      expect(lastStatus).toBe(200);
      results.pricing_scenario = toEndpointResult(pct, SPEC_BUDGET_SCENARIO_MS);

      expect(pct.p95_ms).toBeLessThan(SPEC_BUDGET_SCENARIO_MS);
      expect(pct.p95_ms).toBeLessThan(REGRESSION_BUDGET_MS);
    });
  });
});
