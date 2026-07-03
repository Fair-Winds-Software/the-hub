// Authorized by HUB-1684 (E-FE-9 S5) — signals-panel unit tests: severity
// triple-encoded icon, per-signal contribution, total score, last-advisor
// "Recent" badge threshold, and the Run Plan Advisor deep-link contract.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  CustomerHealthSignalsPanel,
  type DrillInSignal,
} from '../CustomerHealthSignalsPanel';

const SIGNALS: DrillInSignal[] = [
  {
    key: 'stale_no_activity',
    label: 'No activity for 14+ days',
    severity: 'high',
    contributesPoints: 0.3,
    active: true,
  },
  {
    key: 'plan_change_recent',
    label: 'Plan changed in the last 90 days',
    severity: 'medium',
    contributesPoints: 0.15,
    active: true,
  },
];

const PRODUCT_A = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function renderWith(props: {
  signals: DrillInSignal[];
  totalScore: number;
  lastAdvisorRunAt: string | null;
}): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <CustomerHealthSignalsPanel
        {...props}
        tenantId={TENANT_A}
        productId={PRODUCT_A}
      />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
});

describe('CustomerHealthSignalsPanel (HUB-1684)', () => {
  it('renders every active signal with severity triple-encoding + contribution', () => {
    renderWith({
      signals: SIGNALS,
      totalScore: 0.45,
      lastAdvisorRunAt: null,
    });
    expect(
      screen.getByTestId('customer-health-signal-stale_no_activity'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('customer-health-signal-plan_change_recent'),
    ).toBeInTheDocument();
    const highBadge = screen.getByTestId(
      'customer-health-signal-severity-high',
    );
    expect(highBadge.textContent).toContain('High');
    expect(highBadge.textContent).toContain('✕');
    expect(highBadge.getAttribute('aria-label')).toBe('Severity: High');
    const mediumBadge = screen.getByTestId(
      'customer-health-signal-severity-medium',
    );
    expect(mediumBadge.textContent).toContain('Medium');
    expect(mediumBadge.textContent).toContain('⚠');
    // Contribution text.
    expect(
      screen.getByTestId('customer-health-signal-stale_no_activity').textContent,
    ).toContain('+0.30');
  });

  it('renders the healthy empty state when there are no signals', () => {
    renderWith({
      signals: [],
      totalScore: 0,
      lastAdvisorRunAt: null,
    });
    expect(
      screen.getByTestId('customer-health-signals-empty'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('customer-health-signals-empty').textContent,
    ).toContain('healthy');
  });

  it('surfaces the total-score sanity-check line', () => {
    renderWith({
      signals: SIGNALS,
      totalScore: 0.45,
      lastAdvisorRunAt: null,
    });
    const total = screen.getByTestId('customer-health-signals-total');
    expect(total.textContent).toContain('Total churn-risk score');
    expect(total.textContent).toContain('0.45');
  });

  it('shows "Recent" badge when last advisor run is within 7 days', () => {
    renderWith({
      signals: SIGNALS,
      totalScore: 0.45,
      lastAdvisorRunAt: new Date(
        Date.now() - 3 * 24 * 60 * 60 * 1000,
      ).toISOString(),
    });
    expect(
      screen.getByTestId('customer-health-signals-advisor-recent'),
    ).toBeInTheDocument();
  });

  it('omits "Recent" badge when last advisor run is older than 7 days', () => {
    renderWith({
      signals: SIGNALS,
      totalScore: 0.45,
      lastAdvisorRunAt: new Date(
        Date.now() - 30 * 24 * 60 * 60 * 1000,
      ).toISOString(),
    });
    expect(
      screen.queryByTestId('customer-health-signals-advisor-recent'),
    ).toBeNull();
  });

  it('renders "No advisor run yet" when lastAdvisorRunAt is null', () => {
    renderWith({
      signals: [],
      totalScore: 0,
      lastAdvisorRunAt: null,
    });
    expect(
      screen.getByTestId('customer-health-signals-advisor-run').textContent,
    ).toContain('No advisor run yet');
  });

  it('Run Plan Advisor CTA deep-links to /console/plan-advisor/new?productId=X', () => {
    renderWith({
      signals: SIGNALS,
      totalScore: 0.45,
      lastAdvisorRunAt: null,
    });
    const link = screen.getByTestId('customer-health-signals-run-advisor');
    expect(link.getAttribute('href')).toBe(
      `/console/plan-advisor/new?productId=${PRODUCT_A}`,
    );
  });
});
