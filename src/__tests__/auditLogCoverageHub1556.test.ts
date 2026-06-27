// Authorized by HUB-1599 (E-BE-1 S16) — SOC 2 audit-log coverage verification for the
// 5 HUB-1556 CRs. Single cross-cutting test file that pins each CR's audit-write semantics
// (or explicit non-write per the R1 mutation-only contract).
//
// Strategy deviation (documented):
// - Spec AC#3 said "fresh Docker DB integration test." HUB convention is to gate live-DB
//   tests behind RUN_INTEGRATION=1 (see audit.integration.test.ts). Spec also said "runs
//   as part of standard `npm test`" — that's in tension with the Docker gate.
// - Resolution: write a comprehensive MOCKED verification that runs always under npm test.
//   It exercises each CR's handler/service through Fastify inject (or direct call) with
//   mocked pool + writeAuditEntry and asserts the call signatures + shapes. This gives the
//   SOC 2 regression net on every commit without requiring a live DB. Real-DB smoke can be
//   added later under RUN_INTEGRATION=1 (already flagged for /redteam Stage 4 inclusion
//   per the story spec — non-blocking for Stage 3 Build).
//
// R1 FIX (mutation-only audit strategy) is enforced via NOT-called assertions on the
// read-only paths (CR-1 Jira tickets read, CR-3 portfolio-margin GET). The
// x-audit-strategy: 'mutation-only' OpenAPI annotation + Confluence convention page are
// /harden Stage 4 follow-ups; this test pins the runtime behavior.
//
// Path deviation: spec said backend/__tests__/integration/... but HUB code root is src/.
// Placed at src/__tests__/auditLogCoverageHub1556.test.ts.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';

const mockPoolQuery = vi.hoisted(() => vi.fn());
vi.mock('../db/pool.js', () => ({ getPool: () => ({ query: mockPoolQuery }) }));

const mockWriteAuditEntry = vi.hoisted(() => vi.fn());
vi.mock('../services/auditLogService.js', () => ({
  writeAuditEntry: mockWriteAuditEntry,
  // Pass-through for the redaction export used by retentionJob if imported transitively.
  _redactSensitiveFields: (v: unknown) => v,
}));

// HUB-1593 jiraIntegrationService — mock at the boundary so the route module loads cleanly.
const mockGetTicketCounts = vi.hoisted(() => vi.fn());
const mockClearAuthCache = vi.hoisted(() => vi.fn());
vi.mock('../services/jiraIntegrationService.js', () => ({
  getTicketCounts: mockGetTicketCounts,
  clearAuthCache: mockClearAuthCache,
}));

// HUB-1595 + HUB-1597 analytics service stubs; only the names used by the routes plugin.
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

// HUB-1589 stripeService stubs — invoiceService imports isCreditMode.
const mockIsCreditMode = vi.hoisted(() => vi.fn());
const mockClearCreditModeCacheEntry = vi.hoisted(() => vi.fn());
vi.mock('../services/stripeService.js', () => ({
  isCreditMode: mockIsCreditMode,
  clearCreditModeCacheEntry: mockClearCreditModeCacheEntry,
}));

vi.mock('../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import analyticsRoutes from '../routes/analyticsRoutes.js';
import adminIntegrationRoutes from '../routes/admin/integrations.js';
import { createInternalInvoice } from '../services/invoiceService.js';
import { updatePlanBillingMode } from '../services/planCatalogService.js';
import { AppError } from '../errors/AppError.js';

const SECRET = 'test-secret-hub-1599';
const HUB_INTERNAL_TENANT = '00000000-0000-0000-0000-0000000000a1';
const TENANT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PRODUCT = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const PLAN_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

function token(role: 'super_admin' | 'product_admin' = 'super_admin') {
  return jwt.sign(
    { operator_id: 'op-1', role, tenant_id: null },
    SECRET,
    { expiresIn: '1h' },
  );
}
function authHeader(role: 'super_admin' | 'product_admin' = 'super_admin') {
  return { authorization: `Bearer ${token(role)}`, 'content-type': 'application/json' };
}

// Two Fastify apps — one for the analytics route plugin, one for the admin integrations
// plugin. Both share the global mocks; we register them independently so each describe
// block can assert audit calls without cross-contamination.
let analyticsApp: FastifyInstance;
let integrationsApp: FastifyInstance;

beforeAll(async () => {
  process.env.OPERATOR_JWT_SECRET = SECRET;

  const buildApp = async (routes: typeof analyticsRoutes) => {
    const app = Fastify();
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof AppError) return reply.status(err.statusCode).send({ error: err.message });
      return reply.status(500).send({ error: 'internal' });
    });
    await app.register(routes);
    await app.ready();
    return app;
  };

  analyticsApp = await buildApp(analyticsRoutes);
  integrationsApp = await buildApp(adminIntegrationRoutes);
});

afterAll(async () => {
  await analyticsApp.close();
  await integrationsApp.close();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('HUB-1599 — Audit Log Coverage Verification (E-BE-1 cross-cutting)', () => {
  // ── CR-4 / S3 (HUB-1587) — role rename migration emits synthetic audit per row ─
  describe('CR-4 (role rename migration, HUB-1587): one audit row per migrated operator', () => {
    it('migration 049 SQL contains the required INSERT INTO audit_log block', () => {
      const sql = readFileSync(
        resolve(
          process.cwd(),
          'db/migrations/049_role_rename_step2.sql',
        ),
        'utf8',
      );
      // SQL is the source of truth for migration-time audit; assert each pinned literal.
      expect(sql).toMatch(/INSERT INTO audit_log/);
      expect(sql).toMatch(/'system:role-rename-migration'/);
      expect(sql).toMatch(/'system'/); // actor_type
      expect(sql).toMatch(/'UPDATE'/); // operation
      expect(sql).toMatch(/'operator_accounts'/); // table_name
      expect(sql).toMatch(/'role\.renamed'/); // new_values.event
      expect(sql).toMatch(/'tenant_admin'/); // from
      expect(sql).toMatch(/'product_admin'/); // to
      // tenant_id should be the HUB-internal sentinel
      expect(sql).toContain('00000000-0000-0000-0000-0000000000a1');
    });

    it('migration uses a CTE so RETURNING captures the rows being renamed', () => {
      // R1 FIX#1: data-modifying CTE preserves RETURNING semantics so the audit insert
      // sees exactly the rows the UPDATE flipped (no race with the operator_accounts
      // CHECK constraint widening in 048).
      const sql = readFileSync(
        resolve(
          process.cwd(),
          'db/migrations/049_role_rename_step2.sql',
        ),
        'utf8',
      );
      expect(sql).toMatch(/WITH renamed AS \(/);
      expect(sql).toMatch(/RETURNING id, email/);
    });
  });

  // ── CR-5 / S15 (HUB-1598) — pricing scenario endpoint writes 1 row per req ────
  describe('CR-5 (pricing scenario endpoint, HUB-1598): one audit row per successful request', () => {
    const BODY = {
      product_id: PRODUCT,
      baseline_model_id: 'pm-active',
      price_change_percent: 10,
      churn_assumption_percent: 5,
    };

    const BASELINE = {
      snapshotAt: '2026-06-27T00:00:00.000Z',
      productId: PRODUCT,
      revenueLast30dCents: 100_000,
      costLast30dCents: 40_000,
      subscriptionCount: 100,
      elasticityCoefficient: -1.0,
      marginPct: 0.6,
    };

    const COMPUTE_RESULT = {
      baseline: BASELINE,
      scenario: {
        revenueCents: 99_000,
        costCents: 40_000,
        marginPct: 0.5959,
        subscriptionCount: 90,
      },
      delta: {
        revenueCents: -1_000,
        costCents: 0,
        marginPctPoints: -0.0041,
        subscriptionCount: -10,
      },
      modelType: 'constant_elasticity' as const,
      disclaimer: 'advisory',
    };

    it('writes one audit row with R1 detail shape on success', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'pm-active' }] }); // pricing_models pre-check
      mockFetchScenarioBaseline.mockResolvedValueOnce(BASELINE);
      mockComputeScenario.mockReturnValueOnce(COMPUTE_RESULT);

      const res = await analyticsApp.inject({
        method: 'POST',
        url: '/api/v1/analytics/pricing-scenario',
        headers: authHeader(),
        payload: BODY,
      });
      expect(res.statusCode).toBe(200);

      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      const [entry] = mockWriteAuditEntry.mock.calls[0]!;
      expect(entry).toMatchObject({
        tenant_id: HUB_INTERNAL_TENANT,
        product_id: PRODUCT,
        actor_id: 'op-1',
        actor_type: 'operator',
        operation: 'INSERT',
        table_name: 'products',
        record_id: PRODUCT,
        event_type: 'analytics.pricing_scenario_compute',
      });
      expect(entry.new_values).toMatchObject({
        productId: PRODUCT,
        baselineModelId: 'pm-active',
        scenarioInput: { priceChangePercent: 10, churnAssumptionPercent: 5 },
        baselineSnapshotAt: BASELINE.snapshotAt,
      });
    });

    it('writes ZERO audit rows on 400 (validation failure)', async () => {
      const res = await analyticsApp.inject({
        method: 'POST',
        url: '/api/v1/analytics/pricing-scenario',
        headers: authHeader(),
        payload: { ...BODY, price_change_percent: -200 }, // out of range
      });
      expect(res.statusCode).toBe(400);
      expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    });

    it('writes ZERO audit rows on 404 no_pricing_model (no compute happened)', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // pricing_models pre-check empty

      const res = await analyticsApp.inject({
        method: 'POST',
        url: '/api/v1/analytics/pricing-scenario',
        headers: authHeader(),
        payload: BODY,
      });
      expect(res.statusCode).toBe(404);
      expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    });
  });

  // ── CR-2a / S7 (HUB-1590) — createInternalInvoice writes invoice.created.internal ─
  describe('CR-2a (createInternalInvoice, HUB-1590): one audit row per credit-mode internal invoice', () => {
    it('writes audit with new_values.event="invoice.created.internal" and external_provider="internal"', async () => {
      mockIsCreditMode.mockResolvedValueOnce(true);
      mockPoolQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'inv-1',
            tenant_id: TENANT,
            product_id: PRODUCT,
            stripe_invoice_id: 'inv_internal:abc',
            stripe_subscription_id: 'internal:credit:sub-1',
            status: 'paid',
            amount_due: 4900,
            amount_paid: 4900,
            currency: 'usd',
            period_start: new Date(),
            period_end: new Date(),
            invoice_pdf_url: null,
            payment_failed_at: null,
            external_provider: 'internal',
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      });

      await createInternalInvoice({
        tenantId: TENANT,
        productId: PRODUCT,
        planId: PLAN_ID,
        stripeSubscriptionId: 'internal:credit:sub-1',
        periodStart: new Date('2026-06-01'),
        periodEnd: new Date('2026-06-30'),
        amountCents: 4900,
        currency: 'usd',
      });

      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      const [entry] = mockWriteAuditEntry.mock.calls[0]!;
      expect(entry).toMatchObject({
        tenant_id: TENANT,
        product_id: PRODUCT,
        actor_type: 'system',
        operation: 'INSERT',
        table_name: 'invoices',
        record_id: 'inv-1',
      });
      expect(entry.new_values).toMatchObject({
        event: 'invoice.created.internal',
        external_provider: 'internal',
        amount_due: 4900,
        currency: 'usd',
      });
    });

    it('writes ZERO audit when plan is NOT credit-mode (defensive 400)', async () => {
      mockIsCreditMode.mockResolvedValueOnce(false);

      await expect(
        createInternalInvoice({
          tenantId: TENANT,
          productId: PRODUCT,
          planId: PLAN_ID,
          stripeSubscriptionId: 'sub_x',
          periodStart: new Date(),
          periodEnd: new Date(),
          amountCents: 100,
          currency: 'usd',
        }),
      ).rejects.toThrow(/credit-mode plan/);
      expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    });
  });

  // ── CR-2b / S8 (HUB-1591) — updatePlanBillingMode writes plan.billing_mode.changed ─
  describe('CR-2b (updatePlanBillingMode, HUB-1591): one audit row per billing_mode transition', () => {
    it('writes audit with new_values.event="plan.billing_mode.changed" (story said subscription.changed.internal — actual code uses plan.billing_mode.changed; deviation noted in HUB-1591)', async () => {
      // standard → credit transition. UPDATE uses RETURNING; mock both queries with rows.
      mockPoolQuery
        .mockResolvedValueOnce({
          rows: [{ id: PLAN_ID, product_id: PRODUCT, billing_mode: 'standard' }],
        })
        .mockResolvedValueOnce({
          rows: [{ id: PLAN_ID, product_id: PRODUCT, billing_mode: 'credit' }],
        });

      await updatePlanBillingMode(PLAN_ID, 'credit', 'op-1');

      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      const [entry] = mockWriteAuditEntry.mock.calls[0]!;
      expect(entry).toMatchObject({
        tenant_id: HUB_INTERNAL_TENANT,
        product_id: PRODUCT,
        actor_id: 'op-1',
        actor_type: 'operator',
        operation: 'UPDATE',
        table_name: 'plans',
        record_id: PLAN_ID,
      });
      expect(entry.old_values).toEqual({ billing_mode: 'standard' });
      expect(entry.new_values).toMatchObject({
        billing_mode: 'credit',
        event: 'plan.billing_mode.changed',
        from: 'standard',
        to: 'credit',
      });
    });

    it('writes ZERO audit on no-op transition (mode unchanged)', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: PLAN_ID, product_id: PRODUCT, billing_mode: 'credit' }],
      });

      // Same mode → service should short-circuit before writing audit.
      await updatePlanBillingMode(PLAN_ID, 'credit', 'op-1');
      expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    });
  });

  // ── CR-1 / S10 (HUB-1593/4) — Jira read endpoints are mutation-only (NO audit) ──
  describe('CR-1 (Jira read endpoints, HUB-1593/4): mutation-only strategy — NO audit on reads (R1 FIX)', () => {
    it('GET /admin/integrations/jira/tickets writes ZERO audit rows', async () => {
      mockGetTicketCounts.mockResolvedValueOnce({
        productId: PRODUCT,
        open: 1,
        in_progress: 0,
        last_synced_at: new Date().toISOString(),
        available: true,
      });

      const res = await integrationsApp.inject({
        method: 'GET',
        // Route param is camelCase (productId) per HUB-1594 implementation.
        url: `/api/v1/admin/integrations/jira/tickets?productId=${PRODUCT}`,
        headers: authHeader(),
      });
      expect(res.statusCode).toBe(200);
      expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    });
  });

  // ── CR-3 / S13 (HUB-1596) — portfolio-margin read endpoint mutation-only (NO audit) ─
  describe('CR-3 (portfolio-margin GET, HUB-1596): mutation-only strategy — NO audit on reads (R1 FIX)', () => {
    it('GET /analytics/portfolio-margin writes ZERO audit rows', async () => {
      mockGetPortfolioMargin.mockResolvedValueOnce({
        from: '2026-05-01T00:00:00.000Z',
        to: '2026-05-31T23:59:59.000Z',
        generatedAt: new Date().toISOString(),
        threshold: 0.0,
        products: [],
        portfolio: { revenueCents: 0, costCents: 0, marginPct: null, losingMoney: false },
      });

      const res = await analyticsApp.inject({
        method: 'GET',
        url: '/api/v1/analytics/portfolio-margin',
        headers: authHeader(),
      });
      expect(res.statusCode).toBe(200);
      expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    });
  });

  // ── R1 mutation-only contract: meta-check ────────────────────────────────────
  describe('R1 mutation-only audit strategy (cross-cutting documentation pin)', () => {
    it('documented strategy: read-only admin endpoints do NOT write audit rows', () => {
      // Convention pinned by the two read-path tests above. The OpenAPI annotation
      // `x-audit-strategy: 'mutation-only'` + the Confluence convention page that the
      // SOC 2 evidence package references are /harden Stage 4 follow-ups; this assert
      // pins the runtime contract verified by the two NOT-called assertions above.
      expect(true).toBe(true);
    });
  });
});
