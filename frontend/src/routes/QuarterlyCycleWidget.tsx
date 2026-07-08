// Authorized by HUB-1767 (E-V2-PP-5 S8, HUB-1729, HUB-1701) — tenant billing
// surface quarterly cycle + unlock progress widget. Fetches from the S8
// GET /api/v1/tenants/:t/plans/:p/quarterly-cycle endpoint.

import { useEffect, useState } from 'react';
import { apiClient } from '../lib/api';

export interface QuarterlyCyclePreview {
  cycle: {
    cycle_id: string;
    cycle_start: string;
    cycle_end: string;
    cycle_position: 1 | 2 | 3;
    month_start: string;
    month_end: string;
    days_remaining_in_cycle: number;
    days_until_next_unlock: number | null;
  };
  dimensions: Array<{
    dimension_key: string;
    per_month_quantity: number;
    total_this_cycle: number;
    unlocked_to_date: number;
  }>;
}

interface Props {
  tenantId: string;
  planId: string;
  consumedByDimension?: Record<string, number>;
}

export function QuarterlyCycleWidget({ tenantId, planId, consumedByDimension }: Props): React.ReactElement | null {
  const [preview, setPreview] = useState<QuarterlyCyclePreview | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await apiClient.get(`/api/v1/tenants/${tenantId}/plans/${planId}/quarterly-cycle`);
      setPreview((res as { preview: QuarterlyCyclePreview | null }).preview);
      setLoaded(true);
    })().catch(() => setLoaded(true));
  }, [tenantId, planId]);

  if (!loaded) return null;
  if (!preview) return null;

  const { cycle, dimensions } = preview;
  const consumedMap = consumedByDimension ?? {};

  return (
    <div data-testid="quarterly-cycle-widget" className="flex flex-col gap-3 rounded border border-deep-charcoal/15 p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-primary-navy">Current cycle</div>
        <div data-testid="quarterly-cycle-position" className="text-xs text-deep-charcoal/70">
          Month {cycle.cycle_position} of 3
        </div>
      </div>
      <div className="text-xs text-deep-charcoal/70">
        {cycle.cycle_start} → {cycle.cycle_end} · {cycle.days_remaining_in_cycle} days remaining
      </div>
      {cycle.days_until_next_unlock !== null && cycle.days_until_next_unlock <= 1 && (
        <div data-testid="quarterly-cycle-next-unlock-imminent" className="text-xs text-accent-brass">
          Next unlock: tomorrow
        </div>
      )}
      {dimensions.length === 0 && (
        <p data-testid="quarterly-cycle-no-dimensions" className="text-xs italic text-deep-charcoal/60">
          No monthly quota sub-unlocks configured for this plan.
        </p>
      )}
      {dimensions.map((d) => {
        const consumed = consumedMap[d.dimension_key] ?? 0;
        const consumedPct = d.total_this_cycle > 0
          ? Math.min(100, Math.round((consumed / d.total_this_cycle) * 100))
          : 0;
        const warning = consumedPct > 80;
        return (
          <div key={d.dimension_key} className="flex flex-col gap-1" data-testid={`quarterly-cycle-dim-${d.dimension_key}`}>
            <div className="flex items-baseline justify-between text-xs">
              <span className="font-semibold text-primary-navy">{d.dimension_key}</span>
              <span className="text-deep-charcoal/70">
                {consumed} / {d.total_this_cycle} used · {d.unlocked_to_date} unlocked
              </span>
            </div>
            <div
              className="h-2 w-full rounded bg-deep-charcoal/10"
              role="progressbar"
              aria-valuenow={consumed}
              aria-valuemin={0}
              aria-valuemax={d.total_this_cycle}
              aria-label={`${d.dimension_key}: ${consumed} of ${d.total_this_cycle} used`}
            >
              <div
                data-testid={`quarterly-cycle-bar-${d.dimension_key}`}
                className={warning ? 'h-2 rounded bg-ironwake' : 'h-2 rounded bg-accent-brass'}
                style={{ width: `${consumedPct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
