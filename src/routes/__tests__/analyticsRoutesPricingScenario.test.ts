// Authorized by HUB-1598 (E-BE-1 S15, CR-5 chain final) — route tests for
// POST /api/v1/analytics/pricing-scenario. Mocks fetchScenarioBaseline + computeScenario
// + pool (for the active-pricing-model check) + writeAuditEntry + jwt. Asserts:
//   - 200 + ONE audit row per success (R1 FIX#1; one row per request regardless of compute idempotency)
//   - audit detail shape (R1 FIX#2 — productId + baselineModelId + scenarioInput +
//     baselineSnapshotAt + deltaSummary)
//   - snake_case body fields → camelCase service call (D-HUB-SCOPE-039)
//   - 404 PRICING-001 (R2 Amendment 2 / D-HUB-SCOPE-040) + NO audit row
//   - 400 validation paths + NO audit row
//   - RBAC: product_admin allowed
//   - 401 missing auth
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const mockFetchScenarioBaseline = vi.hoisted(() => vi.fn());
const mockComputeScenario = vi.hoisted(() => vi.fn());
vi.mock('../../services/analyticsService.js', () => ({
  fetchScenarioBaseline: mockFetchScenarioBaseline,
  computeScenario: mockComputeScenario,
  getUsageAnalytics: vi.fn(),
  getBillingAnalytics: vi.fn(),
  getPortfolioMargin: vi.fn(),
}));

const mockPoolQuery = vi.hoisted(() => vi.fn());
vi.mock('../../db/pool.js', () => ({ getPool: () => ({ query: mockPoolQuery }) }));

const mockWriteAuditEntry = vi.hoisted(() => vi.fn());
vi.mock('../../services/auditLogService.js', () => ({
  writeAuditEntry: mockWriteAuditEntry,
}));

const mockJwtVerify = vi.hoisted(() => vi.fn());
vi.mock('jsonwebtoken', () => ({ default: { verify: mockJwtVerify } }));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import analyticsRoutes from '../analyticsRoutes.js';
import { AppError } from '../../errors/AppError.js';

const PRODUCT_ID = '11111111-1111-1111-1111-111111111111';

const BASELINE_FIXTURE = {
  snapshotAt: '2026-06-27T00:00:00.000Z',
  productId: PRODUCT_ID,
  revenueLast30dCents: 100_000,
  costLast30dCents: 40_000,
  subscriptionCount: 100,
  elasticityCoefficient: -1.0,
  marginPct: 0.6,
};

const COMPUTE_RESULT_FIXTURE = {
  baseline: BASELINE_FIXTURE,
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
  disclaimer: 'Scenario projections are advisory only...',
};

let app: FastifyInstance;

beforeAll(async () => {
  process.env.OPERATOR_JWT_SECRET = 'test-secret';
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: err.message });
    return reply.status(500).send({ error: 'internal' });
  });
  await app.register(analyticsRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
});

function authFor(role: 'super_admin' | 'product_admin' = 'super_admin') {
  mockJwtVerify.mockReturnValue({
    operator_id: 'op-1',
    role,
    tenant_id: null,
  });
  return {
    authorization: 'Bearer fake-token',
    'content-type': 'application/json',
  };
}

const VALID_BODY = {
  product_id: PRODUCT_ID,
  baseline_model_id: 'pm-active',
  price_change_percent: 10,
  churn_assumption_percent: 5,
};

describe('POST /api/v1/analytics/pricing-scenario (HUB-1598)', () => {
  describe('happy path', () => {
    it('returns 200 + writes ONE audit row with R1 detail shape', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'pm-active' }] });
      mockFetchScenarioBaseline.mockResolvedValueOnce(BASELINE_FIXTURE);
      mockComputeScenario.mockReturnValueOnce(COMPUTE_RESULT_FIXTURE);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/analytics/pricing-scenario',
        headers: authFor(),
        payload: VALID_BODY,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        baseline: BASELINE_FIXTURE,
        scenario: COMPUTE_RESULT_FIXTURE.scenario,
        delta: COMPUTE_RESULT_FIXTURE.delta,
        modelType: 'constant_elasticity',
        baselineSnapshotAt: BASELINE_FIXTURE.snapshotAt,
      });
      expect(typeof body.generatedAt).toBe('string');

      // R1 FIX#1: exactly one audit row per request.
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      const [entry] = mockWriteAuditEntry.mock.calls[0]!;
      expect(entry).toMatchObject({
        tenant_id: '00000000-0000-0000-0000-0000000000a1',
        product_id: PRODUCT_ID,
        actor_id: 'op-1',
        actor_type: 'operator',
        operation: 'INSERT',
        table_name: 'products',
        record_id: PRODUCT_ID,
        event_type: 'analytics.pricing_scenario_compute',
      });
      // R1 FIX#2: full detail payload.
      expect(entry.new_values).toMatchObject({
        productId: PRODUCT_ID,
        baselineModelId: 'pm-active',
        scenarioInput: { priceChangePercent: 10, churnAssumptionPercent: 5 },
        baselineSnapshotAt: BASELINE_FIXTURE.snapshotAt,
        deltaSummary: {
          deltaRevenueCents: -1_000,
          deltaMarginPctPoints: -0.0041,
        },
      });
    });

    it('translates snake_case body fields → camelCase service call (D-HUB-SCOPE-039)', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'pm-active' }] });
      mockFetchScenarioBaseline.mockResolvedValueOnce(BASELINE_FIXTURE);
      mockComputeScenario.mockReturnValueOnce(COMPUTE_RESULT_FIXTURE);

      await app.inject({
        method: 'POST',
        url: '/api/v1/analytics/pricing-scenario',
        headers: authFor(),
        payload: VALID_BODY,
      });

      expect(mockFetchScenarioBaseline).toHaveBeenCalledWith(PRODUCT_ID);
      const [, input] = mockComputeScenario.mock.calls[0]!;
      expect(input).toEqual({ priceChangePercent: 10, churnAssumptionPercent: 5 });
    });

    it('product_admin is allowed (read-only compute)', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'pm-active' }] });
      mockFetchScenarioBaseline.mockResolvedValueOnce(BASELINE_FIXTURE);
      mockComputeScenario.mockReturnValueOnce(COMPUTE_RESULT_FIXTURE);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/analytics/pricing-scenario',
        headers: authFor('product_admin'),
        payload: VALID_BODY,
      });

      expect(res.statusCode).toBe(200);
    });
  });

  describe('idempotency (R1 contract)', () => {
    it('two identical requests → identical compute shape (sans generatedAt) + TWO audit rows', async () => {
      // Each request mocks the same baseline + compute result — deterministic by construction.
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ id: 'pm-active' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'pm-active' }] });
      mockFetchScenarioBaseline
        .mockResolvedValueOnce(BASELINE_FIXTURE)
        .mockResolvedValueOnce(BASELINE_FIXTURE);
      mockComputeScenario
        .mockReturnValueOnce(COMPUTE_RESULT_FIXTURE)
        .mockReturnValueOnce(COMPUTE_RESULT_FIXTURE);

      const a = await app.inject({
        method: 'POST',
        url: '/api/v1/analytics/pricing-scenario',
        headers: authFor(),
        payload: VALID_BODY,
      });
      const b = await app.inject({
        method: 'POST',
        url: '/api/v1/analytics/pricing-scenario',
        headers: authFor(),
        payload: VALID_BODY,
      });

      const stripVolatile = (raw: string) => {
        const j = JSON.parse(raw);
        delete j.generatedAt;
        return JSON.stringify(j);
      };
      expect(stripVolatile(a.body)).toBe(stripVolatile(b.body));

      // R1 FIX#1: per-request audit — two requests → two rows.
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(2);
    });
  });

  describe('404 no_pricing_model (R2 Amendment 2 / D-HUB-SCOPE-040)', () => {
    it('returns 404 PRICING-001 + writes NO audit row when product has no active pricing model', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // no active model

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/analytics/pricing-scenario',
        headers: authFor(),
        payload: VALID_BODY,
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'no_pricing_model', code: 'PRICING-001' });
      expect(mockFetchScenarioBaseline).not.toHaveBeenCalled();
      expect(mockComputeScenario).not.toHaveBeenCalled();
      expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    });
  });

  describe('400 validation', () => {
    const cases: Array<[string, Partial<typeof VALID_BODY>, RegExp]> = [
      ['missing product_id', { product_id: undefined }, /product_id is required/],
      [
        'baseline_model_id wrong type',
        { baseline_model_id: 42 as unknown as string },
        /baseline_model_id must be a string/,
      ],
      [
        'missing price_change_percent',
        { price_change_percent: undefined },
        /price_change_percent must be a finite number/,
      ],
      [
        'price_change_percent ≤ -100',
        { price_change_percent: -100 },
        /price_change_percent must be > -100 and ≤ 1000/,
      ],
      [
        'price_change_percent > 1000',
        { price_change_percent: 1001 },
        /price_change_percent must be > -100 and ≤ 1000/,
      ],
      [
        'price_change_percent NaN',
        { price_change_percent: NaN },
        /price_change_percent must be a finite number/,
      ],
      [
        'missing churn_assumption_percent',
        { churn_assumption_percent: undefined },
        /churn_assumption_percent must be a finite number/,
      ],
      [
        'churn_assumption_percent < 0',
        { churn_assumption_percent: -1 },
        /churn_assumption_percent must be between 0 and 100/,
      ],
      [
        'churn_assumption_percent > 100',
        { churn_assumption_percent: 150 },
        /churn_assumption_percent must be between 0 and 100/,
      ],
    ];

    for (const [label, override, errPattern] of cases) {
      it(`returns 400 + NO audit row when ${label}`, async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/analytics/pricing-scenario',
          headers: authFor(),
          payload: { ...VALID_BODY, ...override },
        });

        expect(res.statusCode).toBe(400);
        expect(res.json().error).toMatch(errPattern);
        expect(mockPoolQuery).not.toHaveBeenCalled();
        expect(mockFetchScenarioBaseline).not.toHaveBeenCalled();
        expect(mockComputeScenario).not.toHaveBeenCalled();
        expect(mockWriteAuditEntry).not.toHaveBeenCalled();
      });
    }
  });

  describe('401 missing auth', () => {
    it('returns 401 + writes NO audit row when Authorization header is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/analytics/pricing-scenario',
        headers: { 'content-type': 'application/json' },
        payload: VALID_BODY,
      });

      expect(res.statusCode).toBe(401);
      expect(mockFetchScenarioBaseline).not.toHaveBeenCalled();
      expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    });
  });
});
