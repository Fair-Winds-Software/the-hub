// Authorized by HUB-1769 (E-V2-PP-5 S10, HUB-1729, HUB-1701) — integration test
// for annualRenewalService.previewAnnualRenewal + scanUpcomingAnnualRenewals.
// Exercises the cross-Epic contract with E-V2-PP-4 grandfatherService.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import {
  previewAnnualRenewal,
  computeAnnualRenewalDate,
  scanUpcomingAnnualRenewals,
} from '../annualRenewalService.js';

const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';
const CONNECTION_STRING = process.env['DATABASE_URL'] ?? 'postgresql://hub:hub@localhost:5432/hub_dev';
const RUN_TAG = `HUB1701PP5A-${Date.now()}`;
const OPERATOR_ID = '00000000-0000-0000-0000-000000009999';

let client: Client;
let tenantId: string;
let productId: string;
let annualPlanId: string;

(RUN_INTEGRATION ? describe : describe.skip)(
  'HUB-1769 (S10): annualRenewalService integration',
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

      const p = await client.query<{ id: string }>(
        `INSERT INTO plans (product_id, key, name, billing_type, billing_interval, unit_amount_cents,
                            stripe_product_id, stripe_price_id, active)
         VALUES ($1, $2, $3, 'flat_rate', 'year', 1000000, $4, $5, true) RETURNING id`,
        [productId, `${RUN_TAG}-a`, `${RUN_TAG} annual`, `prod_${RUN_TAG}A`, `price_${RUN_TAG}A`],
      );
      annualPlanId = p.rows[0]!.id;
    });

    afterAll(async () => {
      await client.query(`DELETE FROM stripe_subscriptions WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM pricing_grandfathers WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM plans WHERE id = $1`, [annualPlanId]);
      await client.query(`DELETE FROM products WHERE id = $1`, [productId]);
      await client.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
      await client.end();
    });

    describe('computeAnnualRenewalDate', () => {
      it('advances one calendar year', () => {
        const next = computeAnnualRenewalDate(new Date('2026-06-15T00:00:00Z'));
        expect(next.toISOString().slice(0, 10)).toBe('2027-06-15');
      });
      it('handles leap day (Feb 29 anchor)', () => {
        const next = computeAnnualRenewalDate(new Date('2024-02-29T00:00:00Z'));
        // JS Date maps Feb 29 → Mar 1 in a non-leap year — documented behavior.
        expect(['2025-02-28', '2025-03-01']).toContain(next.toISOString().slice(0, 10));
      });
    });

    describe('previewAnnualRenewal — grandfather integration', () => {
      it('returns base price when no grandfather applies', async () => {
        const preview = await previewAnnualRenewal(
          tenantId, productId, annualPlanId, new Date('2026-06-15'),
        );
        expect(preview.pricing.base_price_cents).toBe(1000000);
        expect(preview.pricing.effective_price_cents).toBe(1000000);
        expect(preview.pricing.applied_grandfather_id).toBeNull();
      });

      it('applies grandfather delta at renewal date + description mentions discount', async () => {
        const gf = await client.query<{ id: string }>(
          `INSERT INTO pricing_grandfathers
             (tenant_id, product_id, policy_type, delta_cents, effective_from, expires_at,
              terms, created_by_operator_id)
           VALUES ($1, $2, '12_month_lock', -150000, '2026-01-01', '2027-01-01',
             'Locked pricing for annual renewal negotiation window', $3)
           RETURNING id`,
          [tenantId, productId, OPERATOR_ID],
        );
        const preview = await previewAnnualRenewal(
          tenantId, productId, annualPlanId, new Date('2026-06-15'),
        );
        expect(preview.pricing.effective_price_cents).toBe(850000);
        expect(preview.pricing.applied_grandfather_id).toBe(gf.rows[0]!.id);
        expect(preview.invoice_line_description).toContain('Grandfathered discount');
        expect(preview.invoice_line_description).toContain('-$1500.00');

        // Cleanup
        await client.query(`DELETE FROM pricing_grandfathers WHERE id = $1`, [gf.rows[0]!.id]);
      });

      it('grandfather expired before renewal date is ignored', async () => {
        await client.query(
          `INSERT INTO pricing_grandfathers
             (tenant_id, product_id, policy_type, delta_cents, effective_from, expires_at,
              terms, created_by_operator_id)
           VALUES ($1, $2, 'custom', -200000, '2025-01-01', '2025-12-31',
             'Expired grandfather that should NOT apply at renewal', $3)`,
          [tenantId, productId, OPERATOR_ID],
        );
        const preview = await previewAnnualRenewal(
          tenantId, productId, annualPlanId, new Date('2026-06-15'),
        );
        expect(preview.pricing.applied_grandfather_id).toBeNull();
        expect(preview.pricing.effective_price_cents).toBe(1000000);

        await client.query(
          `DELETE FROM pricing_grandfathers WHERE tenant_id = $1 AND effective_from = '2025-01-01'`,
          [tenantId],
        );
      });

      it('rejects non-annual plan with 400', async () => {
        // Create a monthly plan and try to preview it.
        const mp = await client.query<{ id: string }>(
          `INSERT INTO plans (product_id, key, name, billing_type, billing_interval, unit_amount_cents,
                              stripe_product_id, stripe_price_id, active)
           VALUES ($1, $2, $3, 'flat_rate', 'month', 10000, $4, $5, true) RETURNING id`,
          [productId, `${RUN_TAG}-m`, `${RUN_TAG} monthly`, `prod_${RUN_TAG}M2`, `price_${RUN_TAG}M2`],
        );
        await expect(
          previewAnnualRenewal(tenantId, productId, mp.rows[0]!.id, new Date('2026-06-15')),
        ).rejects.toMatchObject({ statusCode: 400 });
        await client.query(`DELETE FROM plans WHERE id = $1`, [mp.rows[0]!.id]);
      });
    });

    describe('scanUpcomingAnnualRenewals — T-30 scheduler', () => {
      it('finds annual subs with renewals in the next 30 days', async () => {
        const now = new Date('2026-06-15T00:00:00Z');
        const periodEnd = new Date('2026-07-10T00:00:00Z'); // 25 days out
        await client.query(
          `INSERT INTO stripe_subscriptions
             (tenant_id, product_id, plan_id, stripe_subscription_id, stripe_price_id, status,
              current_period_start, current_period_end, cancel_at_period_end)
           VALUES ($1, $2, $3, $4, $5, 'active', '2025-07-10', $6, false)`,
          [tenantId, productId, annualPlanId, `sub_${RUN_TAG}A`, `price_${RUN_TAG}A`, periodEnd],
        );
        await client.query(
          `INSERT INTO pricing_grandfathers
             (tenant_id, product_id, policy_type, delta_cents, effective_from, expires_at,
              terms, created_by_operator_id)
           VALUES ($1, $2, 'custom', -100000, '2026-05-01', '2027-05-01',
             'Grandfather in force at T-30 renewal scan', $3)`,
          [tenantId, productId, OPERATOR_ID],
        );

        const res = await scanUpcomingAnnualRenewals(now);
        expect(res.scanned).toBeGreaterThanOrEqual(1);
        expect(res.grandfather_adjustments.length).toBeGreaterThanOrEqual(1);
        const found = res.grandfather_adjustments.find((a) => a.tenant_id === tenantId);
        expect(found).toBeDefined();
        expect(found!.pricing.effective_price_cents).toBe(900000);
      });
    });
  },
);
