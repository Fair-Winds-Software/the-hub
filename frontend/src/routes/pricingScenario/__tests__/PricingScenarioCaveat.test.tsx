// Authorized by HUB-1672 (E-FE-11 S4) — caveat banner + Reset button
// tests. Banner unit test asserts the wording + tooltip; Reset test
// exercises the full parent (PricingScenario) to verify the button
// restores baseline (0, 0) and disables when already at baseline.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PricingScenarioCaveat } from '../PricingScenarioCaveat';
import PricingScenario from '../../PricingScenario';

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
    post: (...args: unknown[]) => apiPostMock(...args),
  },
}));

const PRODUCT_A = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const BE_DISCLAIMER =
  'Scenario projections are advisory only and use a constant-elasticity model.';

const HAPPY_SCENARIO = {
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
  },
  modelType: 'constant_elasticity',
  disclaimer: BE_DISCLAIMER,
  baselineSnapshotAt: '2026-07-03T00:00:00.000Z',
  generatedAt: '2026-07-03T00:00:00.500Z',
};

afterEach(() => {
  cleanup();
});

describe('PricingScenarioCaveat unit (HUB-1672)', () => {
  it('renders the primary warning + BE disclaimer + v0.2 tooltip', () => {
    render(<PricingScenarioCaveat disclaimer={BE_DISCLAIMER} />);
    const banner = screen.getByTestId('pricing-scenario-caveat');
    expect(banner.textContent).toContain('What-if estimate');
    expect(banner.textContent).toContain('Not a prediction');
    expect(banner.getAttribute('title')).toContain('HUB-1547');
    expect(banner.getAttribute('role')).toBe('alert');
    expect(
      screen.getByTestId('pricing-scenario-caveat-disclaimer').textContent,
    ).toBe(BE_DISCLAIMER);
  });

  it('caveat uses sticky positioning (visible above results during scroll)', () => {
    render(<PricingScenarioCaveat disclaimer={BE_DISCLAIMER} />);
    const banner = screen.getByTestId('pricing-scenario-caveat');
    expect(banner.className).toContain('sticky');
  });
});

describe('PricingScenario — Reset button (HUB-1672)', () => {
  function renderPage() {
    return render(
      <MemoryRouter initialEntries={['/console/pricing-scenario']}>
        <Routes>
          <Route path="/console/pricing-scenario" element={<PricingScenario />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  async function pickProductA() {
    await waitFor(() => {
      expect(screen.getByTestId('pricing-scenario-page')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.change(
        screen.getByTestId('pricing-scenario-product'),
        { target: { value: PRODUCT_A } },
      );
    });
  }

  beforeEach(() => {
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiGetMock.mockResolvedValue({
      data: [{ productId: PRODUCT_A, productName: 'Synapz' }],
    });
    apiPostMock.mockResolvedValue(HAPPY_SCENARIO);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Reset button disabled at baseline; enabled after slider change; click restores baseline', async () => {
    await act(async () => {
      renderPage();
    });
    await pickProductA();
    // Reset is disabled at the initial (0, 0) baseline.
    const resetBtn = screen.getByTestId(
      'pricing-scenario-reset',
    ) as HTMLButtonElement;
    expect(resetBtn.disabled).toBe(true);
    // Move the price slider — Reset should enable.
    await act(async () => {
      fireEvent.change(screen.getByTestId('pricing-scenario-price-slider'), {
        target: { value: '15' },
      });
    });
    expect(resetBtn.disabled).toBe(false);
    expect(
      screen.getByTestId('pricing-scenario-price-value').textContent,
    ).toBe('+15%');
    // Click Reset — inputs should be back to 0.
    await act(async () => {
      fireEvent.click(resetBtn);
    });
    expect(
      screen.getByTestId('pricing-scenario-price-value').textContent,
    ).toBe('0%');
    expect(resetBtn.disabled).toBe(true);
  });

  it('caveat surfaces the BE disclaimer verbatim in the ready state', async () => {
    await act(async () => {
      renderPage();
    });
    await pickProductA();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('pricing-scenario-caveat'),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('pricing-scenario-caveat-disclaimer').textContent,
    ).toBe(BE_DISCLAIMER);
  });
});
