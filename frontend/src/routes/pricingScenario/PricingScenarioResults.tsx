// Authorized by HUB-1671 (E-FE-11 S3) — results table: Metric ×
// (Baseline | Scenario | Delta). Delta cells are triple-encoded per
// Ironclad — icon (arrow) + sign in text + color class — so colour is
// never the sole semantic carrier.
//
// Cost is held constant in v0.1 (see analyticsService.computeScenario:
//   costScenarioCents = baseline.costLast30dCents
// ), so the Cost row will always show delta = 0. Displayed anyway for
// operator transparency.
//
// Baseline model summary above the table names the elasticity
// coefficient + snapshot timestamp so operators can see the assumption
// stack that produced the numbers.
import type { ScenarioResponse } from '../PricingScenario';
import {
  formatCount,
  formatCountDelta,
  formatCurrencyCents,
  formatCurrencyDeltaCents,
  formatPercent,
  formatPercentPointsDelta,
} from './pricing-scenario-formatters';

interface PricingScenarioResultsProps {
  payload: ScenarioResponse;
}

type DeltaSign = 'positive' | 'negative' | 'neutral';

function signOf(n: number | null | undefined): DeltaSign {
  if (n == null || n === 0) return 'neutral';
  return n > 0 ? 'positive' : 'negative';
}

interface DeltaCellProps {
  sign: DeltaSign;
  label: string;
  testId: string;
}

function DeltaCell({ sign, label, testId }: DeltaCellProps): React.ReactElement {
  const icon = sign === 'positive' ? '↑' : sign === 'negative' ? '↓' : '→';
  const classes =
    sign === 'positive'
      ? 'text-seafoam'
      : sign === 'negative'
        ? 'text-ironwake'
        : 'text-deep-charcoal/60';
  return (
    <td
      data-testid={testId}
      data-sign={sign}
      className={`py-2 text-right font-mono text-xs ${classes}`}
    >
      <span aria-hidden="true">{icon} </span>
      {label}
    </td>
  );
}

export function PricingScenarioResults({
  payload,
}: PricingScenarioResultsProps): React.ReactElement {
  const { baseline, scenario, delta } = payload;

  const revenueSign = signOf(delta.revenueCents);
  const subscriptionsSign = signOf(delta.subscriptionCount);
  const marginSign = signOf(delta.marginPctPoints);
  const costSign = signOf(delta.costCents);

  return (
    <div className="flex flex-col gap-3">
      <div
        data-testid="pricing-scenario-baseline-summary"
        className="rounded-md border border-deep-charcoal/15 bg-white p-3 text-xs font-body text-deep-charcoal/70"
      >
        <p>
          Baseline snapshot at{' '}
          <code className="font-mono">{baseline.snapshotAt}</code>. Model:
          constant elasticity, coefficient{' '}
          <code className="font-mono">
            {baseline.elasticityCoefficient.toFixed(2)}
          </code>
          . Cost held constant.
        </p>
      </div>

      <table
        data-testid="pricing-scenario-results-table"
        className="w-full border-collapse text-left text-sm font-body"
      >
        <thead>
          <tr className="border-b border-deep-charcoal/15 text-xs text-deep-charcoal/60">
            <th scope="col" className="py-2 text-left">
              Metric
            </th>
            <th scope="col" className="py-2 text-right">
              Baseline
            </th>
            <th scope="col" className="py-2 text-right">
              Scenario
            </th>
            <th scope="col" className="py-2 text-right">
              Delta
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            data-testid="pricing-scenario-row-revenue"
            className="border-b border-deep-charcoal/10"
          >
            <td className="py-2 text-sm text-deep-charcoal">
              Revenue (last 30 days)
            </td>
            <td className="py-2 text-right font-mono text-xs text-deep-charcoal">
              {formatCurrencyCents(baseline.revenueLast30dCents)}
            </td>
            <td className="py-2 text-right font-mono text-xs text-deep-charcoal">
              {formatCurrencyCents(scenario.revenueCents)}
            </td>
            <DeltaCell
              sign={revenueSign}
              label={formatCurrencyDeltaCents(delta.revenueCents)}
              testId="pricing-scenario-delta-revenue"
            />
          </tr>
          <tr
            data-testid="pricing-scenario-row-subscriptions"
            className="border-b border-deep-charcoal/10"
          >
            <td className="py-2 text-sm text-deep-charcoal">Subscriptions</td>
            <td className="py-2 text-right font-mono text-xs text-deep-charcoal">
              {formatCount(baseline.subscriptionCount)}
            </td>
            <td className="py-2 text-right font-mono text-xs text-deep-charcoal">
              {formatCount(scenario.subscriptionCount)}
            </td>
            <DeltaCell
              sign={subscriptionsSign}
              label={formatCountDelta(delta.subscriptionCount)}
              testId="pricing-scenario-delta-subscriptions"
            />
          </tr>
          <tr
            data-testid="pricing-scenario-row-margin"
            className="border-b border-deep-charcoal/10"
          >
            <td className="py-2 text-sm text-deep-charcoal">Margin %</td>
            <td className="py-2 text-right font-mono text-xs text-deep-charcoal">
              {formatPercent(baseline.marginPct)}
            </td>
            <td className="py-2 text-right font-mono text-xs text-deep-charcoal">
              {formatPercent(scenario.marginPct)}
            </td>
            <DeltaCell
              sign={marginSign}
              label={formatPercentPointsDelta(delta.marginPctPoints)}
              testId="pricing-scenario-delta-margin"
            />
          </tr>
          <tr data-testid="pricing-scenario-row-cost">
            <td className="py-2 text-sm text-deep-charcoal">Cost (last 30 days)</td>
            <td className="py-2 text-right font-mono text-xs text-deep-charcoal">
              {formatCurrencyCents(baseline.costLast30dCents)}
            </td>
            <td className="py-2 text-right font-mono text-xs text-deep-charcoal">
              {formatCurrencyCents(scenario.costCents)}
            </td>
            <DeltaCell
              sign={costSign}
              label={formatCurrencyDeltaCents(delta.costCents)}
              testId="pricing-scenario-delta-cost"
            />
          </tr>
        </tbody>
      </table>
    </div>
  );
}
