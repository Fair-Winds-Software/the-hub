// Authorized by HUB-1768 (E-V2-PP-5 S9, HUB-1729, HUB-1701) — integration test
// for quarterlyCycleService.getCurrentQuarterlyCycle + runQuotaSubUnlock +
// getQuarterlyCyclePreview. Native quarterly mode (Stripe interval='month',
// interval_count=3 via INTERVAL_MAP.quarter) per HUB-1762 spike closure.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import {
  getCurrentQuarterlyCycle,
  runQuotaSubUnlock,
  getQuarterlyCyclePreview,
} from '../quarterlyCycleService.js';

const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';
const CONNECTION_STRING = process.env['DATABASE_URL'] ?? 'postgresql://hub:hub@localhost:5432/hub_dev';
const RUN_TAG = `HUB1701PP5Q-${Date.now()}`;

let client: Client;
let tenantId: string;
let productId: string;
let quarterlyPlanId: string;
let monthlyPlanId: string;

(RUN_INTEGRATION ? describe : describe.skip)(
  'HUB-1768 (S9): quarterlyCycleService integration',
  () => {
    beforeAll(async () => {
      client = new Client({ connectionString: CONNECTION_STRING });
      await client.connect();
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

      const qp = await client.query<{ id: string }>(
        `INSERT INTO plans (product_id, key, name, billing_type, billing_interval, unit_amount_cents,
                            stripe_product_id, stripe_price_id, active)
         VALUES ($1, $2, $3, 'flat_rate', 'quarter', 30000, $4, $5, true) RETURNING id`,
        [productId, `${RUN_TAG}-q`, `${RUN_TAG} quarterly`, `prod_${RUN_TAG}Q`, `price_${RUN_TAG}Q`],
      );
      quarterlyPlanId = qp.rows[0]!.id;

      const mp = await client.query<{ id: string }>(
        `INSERT INTO plans (product_id, key, name, billing_type, billing_interval, unit_amount_cents,
                            stripe_product_id, stripe_price_id, active)
         VALUES ($1, $2, $3, 'flat_rate', 'month', 10000, $4, $5, true) RETURNING id`,
        [productId, `${RUN_TAG}-m`, `${RUN_TAG} monthly`, `prod_${RUN_TAG}M`, `price_${RUN_TAG}M`],
      );
      monthlyPlanId = mp.rows[0]!.id;

      await client.query(
        `INSERT INTO plan_quota_sub_unlocks (plan_id, dimension_key, per_month_quantity)
         VALUES ($1, 'content_pieces', 10),
                ($1, 'brand_assets', 5)`,
        [quarterlyPlanId],
      );

      // Seed an active quarterly subscription. current_period_start = 2026-01-15.
      await client.query(
        `INSERT INTO stripe_subscriptions
           (tenant_id, product_id, plan_id, stripe_subscription_id, stripe_price_id, status,
            current_period_start, current_period_end, cancel_at_period_end)
         VALUES ($1, $2, $3, $4, $5, 'active', '2026-01-15', '2026-04-15', false)`,
        [tenantId, productId, quarterlyPlanId, `sub_${RUN_TAG}`, `price_${RUN_TAG}Q`],
      );
    });

    afterAll(async () => {
      await client.query(`DELETE FROM quarterly_cycle_grants WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM stripe_subscriptions WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM plan_quota_sub_unlocks WHERE plan_id IN ($1, $2)`,
        [quarterlyPlanId, monthlyPlanId]);
      await client.query(`DELETE FROM plans WHERE id IN ($1, $2)`, [quarterlyPlanId, monthlyPlanId]);
      await client.query(`DELETE FROM products WHERE id = $1`, [productId]);
      await client.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
      await client.end();
    });

    describe('getCurrentQuarterlyCycle (S4 cycle math)', () => {
      it('returns position 1 on anchor date', () => {
        const c = getCurrentQuarterlyCycle(new Date('2026-01-15'), new Date('2026-01-15'), tenantId);
        expect(c.cycle_position).toBe(1);
        expect(c.cycle_start).toBe('2026-01-15');
        expect(c.cycle_end).toBe('2026-04-15');
      });
      it('returns position 2 one month in', () => {
        const c = getCurrentQuarterlyCycle(new Date('2026-01-15'), new Date('2026-02-20'), tenantId);
        expect(c.cycle_position).toBe(2);
      });
      it('returns position 3 two months in', () => {
        const c = getCurrentQuarterlyCycle(new Date('2026-01-15'), new Date('2026-03-20'), tenantId);
        expect(c.cycle_position).toBe(3);
      });
      it('rolls to next cycle after 3 months', () => {
        const c = getCurrentQuarterlyCycle(new Date('2026-01-15'), new Date('2026-04-20'), tenantId);
        expect(c.cycle_position).toBe(1);
        expect(c.cycle_start).toBe('2026-04-15');
      });
      it('produces stable cycle_id per (tenant, cycle_start)', () => {
        const c1 = getCurrentQuarterlyCycle(new Date('2026-01-15'), new Date('2026-01-20'), tenantId);
        const c2 = getCurrentQuarterlyCycle(new Date('2026-01-15'), new Date('2026-02-20'), tenantId);
        expect(c1.cycle_id).toBe(c2.cycle_id);
      });
      it('days_until_next_unlock is null when in position 3', () => {
        const c = getCurrentQuarterlyCycle(new Date('2026-01-15'), new Date('2026-03-20'), tenantId);
        expect(c.days_until_next_unlock).toBeNull();
      });
    });

    describe('runQuotaSubUnlock (S5)', () => {
      it('grants entitlements for active quarterly subscriptions', async () => {
        const res = await runQuotaSubUnlock(new Date('2026-02-20'));
        expect(res.tenants_processed).toBeGreaterThanOrEqual(1);
        const { rows } = await client.query<{ dimension_key: string; quantity: number; cycle_position: number }>(
          `SELECT dimension_key, quantity, cycle_position FROM quarterly_cycle_grants
            WHERE tenant_id = $1 ORDER BY dimension_key ASC`,
          [tenantId],
        );
        expect(rows.length).toBe(2);
        expect(rows.map((r) => r.dimension_key)).toEqual(['brand_assets', 'content_pieces']);
        expect(rows[0]!.cycle_position).toBe(2);
      });

      it('is idempotent — re-running with same now produces no new grants', async () => {
        const before = await client.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM quarterly_cycle_grants WHERE tenant_id = $1`,
          [tenantId],
        );
        await runQuotaSubUnlock(new Date('2026-02-20'));
        const after = await client.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM quarterly_cycle_grants WHERE tenant_id = $1`,
          [tenantId],
        );
        expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
      });

      it('skips monthly plans', async () => {
        // Seed a monthly-plan sub-unlock row — scheduler must ignore.
        await client.query(
          `INSERT INTO plan_quota_sub_unlocks (plan_id, dimension_key, per_month_quantity)
           VALUES ($1, 'ignored_dim', 99)`,
          [monthlyPlanId],
        );
        const res = await runQuotaSubUnlock(new Date('2026-02-20'));
        const { rows } = await client.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM quarterly_cycle_grants
             WHERE tenant_id = $1 AND dimension_key = 'ignored_dim'`,
          [tenantId],
        );
        expect(rows[0]!.n).toBe('0');
        expect(res).toBeDefined();
      });
    });

    describe('getQuarterlyCyclePreview (S8 backing data)', () => {
      it('returns preview with dimensions × cycle_position quantities', async () => {
        const preview = await getQuarterlyCyclePreview(tenantId, quarterlyPlanId, new Date('2026-02-20'));
        expect(preview).not.toBeNull();
        expect(preview!.cycle.cycle_position).toBe(2);
        const contentPieces = preview!.dimensions.find((d) => d.dimension_key === 'content_pieces');
        expect(contentPieces).toBeDefined();
        expect(contentPieces!.total_this_cycle).toBe(30);
        expect(contentPieces!.unlocked_to_date).toBe(20);
      });

      it('returns null for non-quarterly plan', async () => {
        const preview = await getQuarterlyCyclePreview(tenantId, monthlyPlanId, new Date('2026-02-20'));
        expect(preview).toBeNull();
      });
    });
  },
);
