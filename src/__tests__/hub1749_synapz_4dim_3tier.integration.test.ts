// Authorized by HUB-1749 (E-V2-PP-3 S9, HUB-1727, HUB-1701) — end-to-end integration
// test for a Synapz-shape 4-dimension × 3-tier plan: author via API → seed usage_events
// → compute overage via service → verify math per tier per dimension.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { computeTenantOverage } from '../services/overageAggregationService.js';

const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';
const CONNECTION_STRING = process.env['DATABASE_URL'] ?? 'postgresql://hub:hub@localhost:5432/hub_dev';
const RUN_TAG = `HUB1749-${Date.now()}`;

// Synapz 3-tier shape (Starter / Growth / Enterprise) × 4 dimensions.
const SYNAPZ_DIMENSIONS = [
  { dimension_key: 'rules',          dimension_label: 'Decision Rules',  sort_order: 0 },
  { dimension_key: 'business_users', dimension_label: 'Business Users',  sort_order: 1 },
  { dimension_key: 'evaluations',    dimension_label: 'Rule Evaluations', sort_order: 2 },
  { dimension_key: 'symbolic_ops',   dimension_label: 'Symbolic Ops',    sort_order: 3 },
];

const SYNAPZ_TIERS = [
  {
    upTo: 1000,
    unitAmount: 9900,
    overage_rates: [
      { dimension_key: 'rules',          included_quantity: 25,  rate_per_unit_cents: 25 },
      { dimension_key: 'business_users', included_quantity: 5,   rate_per_unit_cents: 500 },
      { dimension_key: 'evaluations',    included_quantity: 500, rate_per_unit_cents: 10 },
      { dimension_key: 'symbolic_ops',   included_quantity: 100, rate_per_unit_cents: 50 },
    ],
  },
  {
    upTo: 5000,
    unitAmount: 99900,
    overage_rates: [
      { dimension_key: 'rules',          included_quantity: 100,  rate_per_unit_cents: 10 },
      { dimension_key: 'business_users', included_quantity: 50,   rate_per_unit_cents: 100 },
      { dimension_key: 'evaluations',    included_quantity: 1000, rate_per_unit_cents: 5 },
      { dimension_key: 'symbolic_ops',   included_quantity: 500,  rate_per_unit_cents: 20 },
    ],
  },
  {
    upTo: null, // Enterprise: unbounded
    unitAmount: 499900,
    overage_rates: [
      { dimension_key: 'rules',          included_quantity: 1000, rate_per_unit_cents: 5 },
      { dimension_key: 'business_users', included_quantity: 500,  rate_per_unit_cents: 50 },
      { dimension_key: 'evaluations',    included_quantity: 10000, rate_per_unit_cents: 2 },
      { dimension_key: 'symbolic_ops',   included_quantity: 5000, rate_per_unit_cents: 10 },
    ],
  },
];

(RUN_INTEGRATION ? describe : describe.skip)(
  'HUB-1749 (E-V2-PP-3 S9): Synapz 4-dim × 3-tier end-to-end',
  () => {
    let app: FastifyInstance;
    let client: Client;
    let superAdminToken: string;
    let tenantId: string;
    let productId: string;
    let planId: string;

    beforeAll(async () => {
      const { buildApp } = await import('../app.js');
      app = await buildApp();
      await app.ready();

      client = new Client({ connectionString: CONNECTION_STRING });
      await client.connect();

      const jwt = await import('jsonwebtoken');
      const secret = process.env['OPERATOR_JWT_SECRET']!;
      superAdminToken = jwt.default.sign(
        { operator_id: '00000000-0000-0000-0000-00000000fffd', role: 'super_admin', tenant_id: null },
        secret, { expiresIn: '1h' },
      );

      const tRes = await client.query<{ id: string }>(
        `INSERT INTO tenants (name, tenant_type) VALUES ($1, 'internal') RETURNING id`,
        [RUN_TAG],
      );
      tenantId = tRes.rows[0]!.id;
      const pRes = await client.query<{ id: string }>(
        `INSERT INTO products (slug, name, tenant_id) VALUES ($1, $2, $3) RETURNING id`,
        [`${RUN_TAG.toLowerCase()}-prod`, `${RUN_TAG} product`, tenantId],
      );
      productId = pRes.rows[0]!.id;

      // Create plan via direct SQL (POST /admin/plans is unrelated to this test).
      const planRes = await client.query<{ id: string }>(
        `INSERT INTO plans (product_id, key, name, billing_type, active,
                            stripe_product_id, stripe_price_id)
         VALUES ($1, $2, $3, 'tiered', true, $4, $5) RETURNING id`,
        [productId, `${RUN_TAG}-plan`, `${RUN_TAG} plan`, `prod_${RUN_TAG}`, `price_${RUN_TAG}`],
      );
      planId = planRes.rows[0]!.id;

      // Author the plan via API PUT (HUB-1745).
      const putRes = await app.inject({
        method: 'PUT',
        url: `/api/v1/admin/plans/${planId}`,
        headers: { Authorization: `Bearer ${superAdminToken}` },
        payload: { dimensions: SYNAPZ_DIMENSIONS, tiers: SYNAPZ_TIERS },
      });
      expect(putRes.statusCode).toBe(200);
    });

    afterAll(async () => {
      await client.query(`DELETE FROM usage_events WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM plan_metered_dimensions WHERE plan_id = $1`, [planId]);
      await client.query(`DELETE FROM plans WHERE id = $1`, [planId]);
      await client.query(`DELETE FROM products WHERE id = $1`, [productId]);
      await client.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
      await client.end();
      await app.close();
    });

    async function seed(dimension: string, unitCount: number, when: Date): Promise<void> {
      await client.query(
        `INSERT INTO usage_events (tenant_id, product_id, event_type, unit_count, occurred_at, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenantId, productId, dimension, unitCount, when.toISOString(), `${RUN_TAG}-${dimension}-${when.getTime()}-${Math.random()}`],
      );
    }

    it('Growth tier (index 1) — mixed usage across 4 dimensions computes correctly', async () => {
      const period = new Date('2026-06-15T00:00:00Z');
      // Growth tier overage per dimension:
      //   rules 100 included @ 10¢     — seed 300 → 200 over = $20 = 2000 cents
      //   business_users 50 @ 100¢     — seed 40  → 0 over
      //   evaluations 1000 @ 5¢        — seed 1500 → 500 over = 2500 cents
      //   symbolic_ops 500 @ 20¢       — seed 500 → exactly at quota = 0
      await seed('rules', 300, period);
      await seed('business_users', 40, period);
      await seed('evaluations', 1500, period);
      await seed('symbolic_ops', 500, period);

      const rows = await computeTenantOverage(
        tenantId, planId, 1, // Growth
        new Date('2026-06-01T00:00:00Z'),
        new Date('2026-07-01T00:00:00Z'),
      );
      const byKey = new Map(rows.map((r) => [r.dimension_key, r]));
      expect(byKey.get('rules')!.total_cents).toBe(2000);
      expect(byKey.get('business_users')!.total_cents).toBe(0);
      expect(byKey.get('evaluations')!.total_cents).toBe(2500);
      expect(byKey.get('symbolic_ops')!.total_cents).toBe(0);
    });

    it('Enterprise tier (index 2) — unbounded upTo; higher includeds shrink overage cost', async () => {
      const period = new Date('2026-08-15T00:00:00Z');
      // Enterprise: rules 1000 included @ 5¢
      // Same 300 usage → 0 over (well under 1000 included)
      await seed('rules', 300, period);
      const rows = await computeTenantOverage(
        tenantId, planId, 2, // Enterprise
        new Date('2026-08-01T00:00:00Z'),
        new Date('2026-09-01T00:00:00Z'),
      );
      const rulesRow = rows.find((r) => r.dimension_key === 'rules')!;
      expect(rulesRow.usage_quantity).toBe(300);
      expect(rulesRow.overage_quantity).toBe(0);
      expect(rulesRow.total_cents).toBe(0);
    });

    it('Starter tier (index 0) — 25 rules included; 30 usage produces 5 over × 25¢ = 125 cents', async () => {
      const period = new Date('2026-10-15T00:00:00Z');
      await seed('rules', 30, period);
      const rows = await computeTenantOverage(
        tenantId, planId, 0, // Starter
        new Date('2026-10-01T00:00:00Z'),
        new Date('2026-11-01T00:00:00Z'),
      );
      const rulesRow = rows.find((r) => r.dimension_key === 'rules')!;
      expect(rulesRow.usage_quantity).toBe(30);
      expect(rulesRow.included_quantity).toBe(25);
      expect(rulesRow.overage_quantity).toBe(5);
      expect(rulesRow.rate_per_unit_cents).toBe(25);
      expect(rulesRow.total_cents).toBe(125);
    });

    it('same usage costs less on Enterprise than on Starter (rate degression)', async () => {
      // Reuse October rules seed: 30 rules @ Starter costs 125; @ Enterprise costs 0.
      const period = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z') };
      const starterRows = await computeTenantOverage(tenantId, planId, 0, period.from, period.to);
      const enterpriseRows = await computeTenantOverage(tenantId, planId, 2, period.from, period.to);
      const starterRules = starterRows.find((r) => r.dimension_key === 'rules')!.total_cents;
      const enterpriseRules = enterpriseRows.find((r) => r.dimension_key === 'rules')!.total_cents;
      expect(starterRules).toBeGreaterThan(enterpriseRules);
    });
  },
);
