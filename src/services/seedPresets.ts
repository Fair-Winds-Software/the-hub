// Authorized by HUB-1798 (S2 of HUB-1784) — hand-authored SeedPlan presets. Each preset is
// a small builder function so IDs can be generated per invocation (avoiding collisions if a
// preset is applied in 'add' mode twice). The registry is code-only — adding a preset is a
// Story-scoped decision, not runtime configuration.
//
// Design notes:
//   - Presets construct their own IDs (`cus_p1_<n>`, `prod_p1`, ...) so subscription
//     references to customer/price IDs are known at plan build time.
//   - When a preset is applied twice in 'add' mode, the second call will hit unique-key
//     violations on the IDs. That's intentional — running the same preset twice without
//     'replace' is almost always operator error; the DB error surfaces it.
//   - Currency is USD across all presets; add a per-preset currency knob only when a
//     use case emerges.
import type { SeedPlan } from './seedPromptService.js';

export interface SeedPreset {
  id: string;
  label: string;
  description: string;
  build(): SeedPlan;
}

// ── active-customers-500 ──────────────────────────────────────────────────────

const activeCustomers500: SeedPreset = {
  id: 'active-customers-500',
  label: '500 active customers',
  description:
    '500 customers each on a single standard monthly plan; all subscriptions status=active. Useful for portfolio-scale UI performance testing.',
  build(): SeedPlan {
    const productId = 'prod_ac500';
    const priceId = 'price_ac500';
    const customers = Array.from({ length: 500 }, (_, i) => ({
      id: `cus_ac500_${i}`,
      email: `active-${i}@preset.example`,
      name: `Preset Active ${i}`,
    }));
    const subscriptions = customers.map((c) => ({
      id: `sub_ac500_${c.id.split('_').pop()}`,
      customer: c.id,
      status: 'active',
      items: [{ price: priceId, quantity: 1 }],
    }));
    return {
      products: [{ id: productId, name: 'Preset Standard Monthly' }],
      prices: [
        {
          id: priceId,
          product: productId,
          unit_amount: 4900,
          currency: 'usd',
          recurring_interval: 'month',
        },
      ],
      customers,
      subscriptions,
    };
  },
};

// ── churned-mix ───────────────────────────────────────────────────────────────

const churnedMix: SeedPreset = {
  id: 'churned-mix',
  label: 'Churned mix',
  description:
    '200 customers with a 60/25/15 active/past_due/canceled split. Useful for churn dashboards + failed-payment flows.',
  build(): SeedPlan {
    const productId = 'prod_cm200';
    const priceId = 'price_cm200';
    const total = 200;
    const activeCount = 120;
    const pastDueCount = 50;
    // Remaining 30 → canceled

    const customers = Array.from({ length: total }, (_, i) => ({
      id: `cus_cm200_${i}`,
      email: `churn-${i}@preset.example`,
      name: `Preset Churn ${i}`,
    }));

    const subscriptions = customers.map((c, i) => {
      const status =
        i < activeCount ? 'active' : i < activeCount + pastDueCount ? 'past_due' : 'canceled';
      return {
        id: `sub_cm200_${i}`,
        customer: c.id,
        status,
        items: [{ price: priceId, quantity: 1 }],
        ...(status === 'canceled' ? { cancel_at_period_end: true, canceled_at: Math.floor(Date.now() / 1000) } : {}),
      };
    });

    return {
      products: [{ id: productId, name: 'Preset Standard Monthly' }],
      prices: [
        {
          id: priceId,
          product: productId,
          unit_amount: 2900,
          currency: 'usd',
          recurring_interval: 'month',
        },
      ],
      customers,
      subscriptions,
    };
  },
};

// ── discount-heavy ────────────────────────────────────────────────────────────

const discountHeavy: SeedPreset = {
  id: 'discount-heavy',
  label: 'Discount-heavy',
  description:
    '100 customers, 5 coupons of varying types, ~30% of customers with a coupon attached via a discount. Useful for discount-application flows.',
  build(): SeedPlan {
    const productId = 'prod_dh100';
    const priceId = 'price_dh100';
    const total = 100;
    const discountedCount = 30; // 30% of customers

    const customers = Array.from({ length: total }, (_, i) => ({
      id: `cus_dh100_${i}`,
      email: `discount-${i}@preset.example`,
      name: `Preset Discount ${i}`,
    }));

    // 5 coupons: 3 percent-off (10/20/30), 2 amount-off (500/2000).
    const coupons = [
      { id: 'coupon_dh_pct10', duration: 'once', percent_off: 10, name: '10% off once' },
      { id: 'coupon_dh_pct20', duration: 'once', percent_off: 20, name: '20% off once' },
      { id: 'coupon_dh_pct30', duration: 'forever', percent_off: 30, name: '30% off forever' },
      { id: 'coupon_dh_amt500', duration: 'once', amount_off: 500, currency: 'usd', name: '$5 off once' },
      { id: 'coupon_dh_amt2000', duration: 'once', amount_off: 2000, currency: 'usd', name: '$20 off once' },
    ];

    // Assign coupons round-robin to the first `discountedCount` customers.
    const discounts = customers.slice(0, discountedCount).map((c, i) => ({
      id: `disc_dh_${i}`,
      customer: c.id,
      coupon: coupons[i % coupons.length]!.id,
    }));

    return {
      products: [{ id: productId, name: 'Preset Standard Monthly' }],
      prices: [
        {
          id: priceId,
          product: productId,
          unit_amount: 4900,
          currency: 'usd',
          recurring_interval: 'month',
        },
      ],
      customers,
      coupons,
      discounts,
    };
  },
};

// ── Registry ───────────────────────────────────────────────────────────────────

export const SEED_PRESETS: readonly SeedPreset[] = [
  activeCustomers500,
  churnedMix,
  discountHeavy,
] as const;

export function getPreset(id: string): SeedPreset | undefined {
  return SEED_PRESETS.find((p) => p.id === id);
}

export function listPresets(): Array<Pick<SeedPreset, 'id' | 'label' | 'description'>> {
  return SEED_PRESETS.map(({ id, label, description }) => ({ id, label, description }));
}
