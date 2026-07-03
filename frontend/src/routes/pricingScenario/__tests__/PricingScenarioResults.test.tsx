// Authorized by HUB-1671 (E-FE-11 S3) — results-table unit tests:
// baseline / scenario / delta rendering; delta triple-encoding (icon +
// sign in text + color class via data-sign); formatters + margin-pp
// delta; baseline model summary.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PricingScenarioResults } from '../PricingScenarioResults';
import type { ScenarioResponse } from '../../PricingScenario';

const PRODUCT_A = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

function makePayload(over: Partial<ScenarioResponse['delta']> = {}): ScenarioResponse {
  return {
    baseline: {
      snapshotAt: '2026-07-03T00:00:00.000Z',
      productId: PRODUCT_A,
      revenueLast30dCents: 500000,
      costLast30dCents: 100000,
      subscriptionCount: 20,
      elasticityCoefficient: -1,
      marginPct: 0.8,
    },
    scenario: {
      revenueCents: 525000,
      costCents: 100000,
      marginPct: 0.809,
      subscriptionCount: 19,
    },
    delta: {
      revenueCents: 25000,
      costCents: 0,
      marginPctPoints: 0.009,
      subscriptionCount: -1,
      ...over,
    },
    modelType: 'constant_elasticity',
    disclaimer: 'Scenario projections are advisory only...',
    baselineSnapshotAt: '2026-07-03T00:00:00.000Z',
    generatedAt: '2026-07-03T00:00:00.500Z',
  };
}

afterEach(() => {
  cleanup();
});

describe('PricingScenarioResults (HUB-1671)', () => {
  it('renders the baseline summary + four metric rows', () => {
    render(<PricingScenarioResults payload={makePayload()} />);
    expect(
      screen.getByTestId('pricing-scenario-baseline-summary'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('pricing-scenario-results-table'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('pricing-scenario-row-revenue')).toBeInTheDocument();
    expect(
      screen.getByTestId('pricing-scenario-row-subscriptions'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('pricing-scenario-row-margin')).toBeInTheDocument();
    expect(screen.getByTestId('pricing-scenario-row-cost')).toBeInTheDocument();
  });

  it('revenue row: baseline $5,000.00 / scenario $5,250.00 / delta +$250.00 positive', () => {
    render(<PricingScenarioResults payload={makePayload()} />);
    const row = screen.getByTestId('pricing-scenario-row-revenue');
    expect(row.textContent).toContain('$5,000.00');
    expect(row.textContent).toContain('$5,250.00');
    const delta = screen.getByTestId('pricing-scenario-delta-revenue');
    expect(delta.textContent).toContain('+$250.00');
    expect(delta.getAttribute('data-sign')).toBe('positive');
    expect(delta.textContent).toContain('↑');
  });

  it('subscriptions row: delta -1 renders negative + down arrow', () => {
    render(<PricingScenarioResults payload={makePayload()} />);
    const delta = screen.getByTestId('pricing-scenario-delta-subscriptions');
    expect(delta.getAttribute('data-sign')).toBe('negative');
    expect(delta.textContent).toContain('↓');
    expect(delta.textContent).toContain('1');
  });

  it('margin row: renders percent baseline + pp delta', () => {
    render(<PricingScenarioResults payload={makePayload()} />);
    const row = screen.getByTestId('pricing-scenario-row-margin');
    expect(row.textContent).toContain('80%');
    const delta = screen.getByTestId('pricing-scenario-delta-margin');
    expect(delta.textContent).toContain('pp');
    expect(delta.getAttribute('data-sign')).toBe('positive');
  });

  it('cost row: delta 0 renders neutral + neutral arrow', () => {
    render(<PricingScenarioResults payload={makePayload()} />);
    const delta = screen.getByTestId('pricing-scenario-delta-cost');
    expect(delta.getAttribute('data-sign')).toBe('neutral');
    expect(delta.textContent).toContain('→');
  });

  it('baseline summary names the elasticity coefficient + snapshot', () => {
    render(<PricingScenarioResults payload={makePayload()} />);
    const summary = screen.getByTestId('pricing-scenario-baseline-summary');
    expect(summary.textContent).toContain('-1.00');
    expect(summary.textContent).toContain('2026-07-03T00:00:00.000Z');
  });

  it('null margin (no baseline) renders — instead of NaN', () => {
    render(
      <PricingScenarioResults
        payload={{
          ...makePayload(),
          baseline: { ...makePayload().baseline, marginPct: null },
          scenario: { ...makePayload().scenario, marginPct: null },
          delta: { ...makePayload().delta, marginPctPoints: null },
        }}
      />,
    );
    const row = screen.getByTestId('pricing-scenario-row-margin');
    expect(row.textContent).toContain('—');
    const delta = screen.getByTestId('pricing-scenario-delta-margin');
    expect(delta.textContent).toContain('—');
  });
});
