// Authorized by HUB-1745 (E-V2-PP-3 S5, HUB-1727, HUB-1701) — pricing GET/PUT roundtrip
// for the extended dimensions[] + tiers-with-overage_rates shape. Also covers HUB-1748
// (S8) — v0.1 back-compat check that a payload WITHOUT dimensions[] round-trips
// unchanged.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client } from 'pg';

const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';
const CONNECTION_STRING = process.env['DATABASE_URL'] ?? 'postgresql://hub:hub@localhost:5432/hub_dev';
const RUN_TAG = `HUB1745-${Date.now()}`;

(RUN_INTEGRATION ? describe : describe.skip)(
  'HUB-1745 (E-V2-PP-3 S5) + HUB-1748 (S8): pricing dimensions[] roundtrip',
  () => {
    let app: FastifyInstance;
    let client: Client;
    let superAdminToken: string;
    let productId: string;
    let planId: string;
    let flatPlanId: string;

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
      const tenantId = tRes.rows[0]!.id;
      const pRes = await client.query<{ id: string }>(
        `INSERT INTO products (slug, name, tenant_id) VALUES ($1, $2, $3) RETURNING id`,
        [`${RUN_TAG.toLowerCase()}-prod`, `${RUN_TAG} product`, tenantId],
      );
      productId = pRes.rows[0]!.id;

      const plan1 = await client.query<{ id: string }>(
        `INSERT INTO plans (product_id, key, name, billing_type, active, stripe_product_id, stripe_price_id)
         VALUES ($1, $2, $3, 'tiered', true, $4, $5) RETURNING id`,
        [productId, `${RUN_TAG}-plan`, `${RUN_TAG} plan`, `prod_${RUN_TAG}`, `price_${RUN_TAG}`],
      );
      planId = plan1.rows[0]!.id;

      const plan2 = await client.query<{ id: string }>(
        `INSERT INTO plans (product_id, key, name, billing_type, active, stripe_product_id, stripe_price_id)
         VALUES ($1, $2, $3, 'flat_rate', true, $4, $5) RETURNING id`,
        [productId, `${RUN_TAG}-flat`, `${RUN_TAG} flat`, `prod_${RUN_TAG}f`, `price_${RUN_TAG}f`],
      );
      flatPlanId = plan2.rows[0]!.id;
    });

    afterAll(async () => {
      await client.query(`DELETE FROM plan_metered_dimensions WHERE plan_id IN ($1, $2)`, [planId, flatPlanId]);
      await client.query(`DELETE FROM plans WHERE id IN ($1, $2)`, [planId, flatPlanId]);
      await client.query(`DELETE FROM products WHERE id = $1`, [productId]);
      await client.query(`DELETE FROM tenants WHERE name = $1`, [RUN_TAG]);
      await client.end();
      await app.close();
    });

    const auth = () => ({ Authorization: `Bearer ${superAdminToken}` });

    it('PUT accepts dimensions[] + tiers with overage_rates; GET returns them (S5 AC 1-3)', async () => {
      const dimensions = [
        { dimension_key: 'rules', dimension_label: 'Rules', sort_order: 0 },
        { dimension_key: 'business_users', dimension_label: 'Business Users', sort_order: 1 },
      ];
      const tiers = [
        {
          upTo: 5000,
          unitAmount: 99900,
          overage_rates: [
            { dimension_key: 'rules', included_quantity: 100, rate_per_unit_cents: 10 },
            { dimension_key: 'business_users', included_quantity: 50, rate_per_unit_cents: 100 },
          ],
        },
      ];

      const putRes = await app.inject({
        method: 'PUT',
        url: `/api/v1/admin/plans/${planId}`,
        headers: auth(),
        payload: { dimensions, tiers },
      });
      expect(putRes.statusCode).toBe(200);

      // Verify GET reflects the shape.
      const getRes = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/plans?productId=${productId}`,
        headers: auth(),
      });
      expect(getRes.statusCode).toBe(200);
      const list = JSON.parse(getRes.body) as { data: Array<Record<string, unknown>> };
      const plan = list.data.find((p) => p['id'] === planId)!;
      expect(plan['dimensions']).toEqual(dimensions);
      // tiers is a JSONB round-trip; overage_rates is nested.
      const returnedTiers = plan['tiers'] as Array<{ overage_rates: Array<{ dimension_key: string }> }>;
      expect(returnedTiers[0]!.overage_rates).toHaveLength(2);
      expect(returnedTiers[0]!.overage_rates[0]!.dimension_key).toBe('rules');
    });

    it('PUT rejects bad dimension_key (uppercase) with 400', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/admin/plans/${planId}`,
        headers: auth(),
        payload: { dimensions: [{ dimension_key: 'BadKey', dimension_label: 'X', sort_order: 0 }] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('snake_case');
    });

    it('PUT rejects overage_rates row with negative rate_per_unit_cents with 400', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/admin/plans/${planId}`,
        headers: auth(),
        payload: {
          tiers: [{
            upTo: 100, unitAmount: 100,
            overage_rates: [
              { dimension_key: 'rules', included_quantity: 0, rate_per_unit_cents: -5 },
            ],
          }],
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('PUT sync: removing a dimension deletes its plan_metered_dimensions row', async () => {
      // Start with 2 dimensions on planId; PUT with only 1 — the other should be gone.
      const putRes = await app.inject({
        method: 'PUT',
        url: `/api/v1/admin/plans/${planId}`,
        headers: auth(),
        payload: {
          dimensions: [{ dimension_key: 'rules', dimension_label: 'Rules', sort_order: 0 }],
        },
      });
      expect(putRes.statusCode).toBe(200);
      const { rows } = await client.query<{ dimension_key: string }>(
        `SELECT dimension_key FROM plan_metered_dimensions WHERE plan_id = $1`, [planId],
      );
      expect(rows.map((r) => r.dimension_key)).toEqual(['rules']);
    });

    it('HUB-1748 (S8) contract test: v0.1 payload without dimensions[] round-trips (back-compat)', async () => {
      // Flat plan starts with no dimensions and no tiers. PUT only name — no dimensions
      // field. GET should still return dimensions: [] (empty array).
      const putRes = await app.inject({
        method: 'PUT',
        url: `/api/v1/admin/plans/${flatPlanId}`,
        headers: auth(),
        payload: { name: `${RUN_TAG} flat renamed` },
      });
      expect(putRes.statusCode).toBe(200);
      const getRes = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/plans?productId=${productId}`,
        headers: auth(),
      });
      const list = JSON.parse(getRes.body) as { data: Array<Record<string, unknown>> };
      const flat = list.data.find((p) => p['id'] === flatPlanId)!;
      expect(flat['name']).toBe(`${RUN_TAG} flat renamed`);
      expect(flat['dimensions']).toEqual([]);
      // No phantom plan_metered_dimensions rows.
      const { rows } = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM plan_metered_dimensions WHERE plan_id = $1`, [flatPlanId],
      );
      expect(parseInt(rows[0]!.n, 10)).toBe(0);
    });
  },
);
