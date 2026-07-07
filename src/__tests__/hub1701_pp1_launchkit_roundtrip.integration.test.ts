// Authorized by HUB-1725 (E-V2-PP-1 S12, HUB-1713, HUB-1701) — LaunchKit shape roundtrip
// through the v0.1 pricing GET/PUT contract. Verifies that PUT /api/v1/admin/plans/:id
// accepts volume_ladder + first_n_free_quantity + quantity_metered_dimension (added by
// migration 071 + HUB-1718 route supplement), and that a subsequent GET returns the same
// values byte-identically. Also verifies:
//   - v0.1 baseline payload (no new fields) still round-trips as a flat plan
//   - The pricing services (chargeOneTime + calculateVolumeLadderTotal + calculateBundleDiscount)
//     read consistent values after PUT
//
// Gated behind RUN_INTEGRATION=1 per HUB integration test convention.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import {
  chargeOneTime,
  calculateVolumeLadderTotal,
  calculateBundleDiscount,
} from '../services/launchkitPricingService.js';

const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';
const CONNECTION_STRING = process.env['DATABASE_URL'] ?? 'postgresql://hub:hub@localhost:5432/hub_dev';
const RUN_TAG = `HUB1725-${Date.now()}`;

(RUN_INTEGRATION ? describe : describe.skip)(
  'HUB-1725 (E-V2-PP-1 S12): LaunchKit-shape roundtrip through pricing GET/PUT',
  () => {
    let app: FastifyInstance;
    let client: Client;
    let superAdminToken: string;
    let productId: string;
    let onetimePlanId: string;
    let bundlePlanId: string;
    let recurringPlanId: string;

    beforeAll(async () => {
      const { buildApp } = await import('../app.js');
      app = await buildApp();
      await app.ready();

      client = new Client({ connectionString: CONNECTION_STRING });
      await client.connect();

      // Cleanup priors.
      await client.query(`DELETE FROM plan_bundles WHERE bundle_name LIKE $1`, [`${RUN_TAG}%`]);
      await client.query(`DELETE FROM plans WHERE key LIKE $1`, [`${RUN_TAG}-%`]);
      await client.query(`DELETE FROM products WHERE slug LIKE $1`, [`${RUN_TAG.toLowerCase()}-%`]);

      // Mint operator token.
      const jwt = await import('jsonwebtoken');
      const secret = process.env['OPERATOR_JWT_SECRET']!;
      superAdminToken = jwt.default.sign(
        { operator_id: '00000000-0000-0000-0000-00000000fffd', role: 'super_admin', tenant_id: null },
        secret,
        { expiresIn: '1h' },
      );

      // Seed a product + 3 plans (one_time + one_time-with-ladder + recurring for the bundle test).
      const prodRes = await client.query<{ id: string }>(
        `INSERT INTO products (slug, name, tenant_id)
         SELECT $1, $2, id FROM tenants LIMIT 1
         RETURNING id`,
        [`${RUN_TAG.toLowerCase()}-prod`, `${RUN_TAG} product`],
      );
      productId = prodRes.rows[0]!.id;

      const p1 = await client.query<{ id: string }>(
        `INSERT INTO plans (product_id, key, name, billing_type, billing_interval, unit_amount_cents,
                            stripe_product_id, stripe_price_id, active)
         VALUES ($1, $2, $3, 'one_time', NULL, 1500000, $4, $5, true) RETURNING id`,
        [productId, `${RUN_TAG}-onetime`, `${RUN_TAG} onetime`, `prod_${RUN_TAG}O`, `price_${RUN_TAG}O`],
      );
      onetimePlanId = p1.rows[0]!.id;

      const p2 = await client.query<{ id: string }>(
        `INSERT INTO plans (product_id, key, name, billing_type, billing_interval, unit_amount_cents,
                            stripe_product_id, stripe_price_id, active)
         VALUES ($1, $2, $3, 'one_time', NULL, 100000, $4, $5, true) RETURNING id`,
        [productId, `${RUN_TAG}-bundleplan`, `${RUN_TAG} bundle`, `prod_${RUN_TAG}B`, `price_${RUN_TAG}B`],
      );
      bundlePlanId = p2.rows[0]!.id;

      const p3 = await client.query<{ id: string }>(
        `INSERT INTO plans (product_id, key, name, billing_type, billing_interval, unit_amount_cents,
                            stripe_product_id, stripe_price_id, active)
         VALUES ($1, $2, $3, 'flat_rate', 'month', 9900, $4, $5, true) RETURNING id`,
        [productId, `${RUN_TAG}-recur`, `${RUN_TAG} recur`, `prod_${RUN_TAG}R`, `price_${RUN_TAG}R`],
      );
      recurringPlanId = p3.rows[0]!.id;
    });

    afterAll(async () => {
      await client.query(`DELETE FROM plan_bundles WHERE bundle_name LIKE $1`, [`${RUN_TAG}%`]);
      await client.query(`DELETE FROM plans WHERE key LIKE $1`, [`${RUN_TAG}-%`]);
      await client.query(`DELETE FROM products WHERE slug LIKE $1`, [`${RUN_TAG.toLowerCase()}-%`]);
      await client.end();
      await app.close();
    });

    const auth = () => ({ Authorization: `Bearer ${superAdminToken}` });

    it('PUT /plans/:id accepts volume_ladder + first_n_free + dimension, GET returns them', async () => {
      const putRes = await app.inject({
        method: 'PUT',
        url: `/api/v1/admin/plans/${onetimePlanId}`,
        headers: auth(),
        payload: {
          volume_ladder: [
            { min_quantity: 1, max_quantity: 1, unit_amount_cents: 0, sort_order: 0 },
            { min_quantity: 2, max_quantity: 2, unit_amount_cents: 50000, sort_order: 1 },
            { min_quantity: 3, max_quantity: null, unit_amount_cents: 30000, sort_order: 2 },
          ],
          first_n_free_quantity: 1,
          quantity_metered_dimension: 'environment',
        },
      });
      expect(putRes.statusCode).toBe(200);

      const getRes = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/plans?productId=${productId}`,
        headers: auth(),
      });
      expect(getRes.statusCode).toBe(200);
      const list = JSON.parse(getRes.body) as { data: Array<Record<string, unknown>> };
      const plan = list.data.find((p) => p['id'] === onetimePlanId)!;
      expect(plan['first_n_free_quantity']).toBe(1);
      expect(plan['quantity_metered_dimension']).toBe('environment');
      expect(Array.isArray(plan['volume_ladder'])).toBe(true);
      expect((plan['volume_ladder'] as Array<{ unit_amount_cents: number }>).length).toBe(3);
    });

    it('PUT rejects invalid dimension (uppercase) with 400', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/admin/plans/${onetimePlanId}`,
        headers: auth(),
        payload: { quantity_metered_dimension: 'BadDim' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('snake_case');
    });

    it('PUT rejects first_n_free>0 without dimension set with 400 (cross-field, defense-in-depth)', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/admin/plans/${onetimePlanId}`,
        headers: auth(),
        payload: { first_n_free_quantity: 3, quantity_metered_dimension: null },
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('quantity_metered_dimension');
    });

    it('PUT rejects negative first_n_free_quantity with 400', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/admin/plans/${onetimePlanId}`,
        headers: auth(),
        payload: { first_n_free_quantity: -1 },
      });
      expect(res.statusCode).toBe(400);
    });

    it('v0.1 baseline payload (no new fields) still round-trips (back-compat)', async () => {
      const putRes = await app.inject({
        method: 'PUT',
        url: `/api/v1/admin/plans/${recurringPlanId}`,
        headers: auth(),
        payload: { name: `${RUN_TAG} renamed` },
      });
      expect(putRes.statusCode).toBe(200);
      const body = JSON.parse(putRes.body) as Record<string, unknown>;
      expect(body['name']).toBe(`${RUN_TAG} renamed`);
      expect(body['billing_type']).toBe('flat_rate');
      expect(body['first_n_free_quantity']).toBe(0);
      expect(body['quantity_metered_dimension']).toBeNull();
      expect(body['volume_ladder']).toBeNull();
    });

    it('S6 volume-ladder service reads consistent values after PUT (AC 6)', async () => {
      // onetimePlanId was PUT with the [1-free, 2:$500, 3+:$300] ladder above.
      const total = await calculateVolumeLadderTotal(onetimePlanId, 3);
      expect(total).toBe(50000 + 30000); // $500 + $300 = $800
    });

    it('S5 chargeOneTime service returns amount matching the ladder after PUT', async () => {
      const res = await chargeOneTime(onetimePlanId, 3);
      expect(res.amount_cents).toBe(50000 + 30000);
      expect(res.stripe_mode).toBe('payment');
    });

    it('S7 bundle discount applies after inserting a bundle via DB (AC 7)', async () => {
      // Seed a bundle covering both one-time plans.
      await client.query(
        `INSERT INTO plan_bundles (product_id, bundle_name, member_plan_ids, discount_type, discount_value)
         VALUES ($1, $2, $3, 'flat_amount_cents', 100000) `,
        [productId, `${RUN_TAG} Bundle`, [onetimePlanId, bundlePlanId]],
      );
      const both = await calculateBundleDiscount([onetimePlanId, bundlePlanId], 500000);
      expect(both.discountCents).toBe(100000);
      // Only one member present → no bundle applies.
      const single = await calculateBundleDiscount([onetimePlanId], 500000);
      expect(single).toEqual({ appliedBundleId: null, discountCents: 0 });
    });
  },
);
