// Authorized by HUB-1670 (E-FE-11 S2) — calculator inputs + debounced
// recompute + AbortController + loading + BE-error inline tests.
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
import PricingScenario from '../PricingScenario';
import { ApiError } from '../../lib/errors';

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
vi.mock('../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
    post: (...args: unknown[]) => apiPostMock(...args),
  },
}));

const PRODUCT_A = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

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
  disclaimer: 'Scenario projections are advisory only...',
  baselineSnapshotAt: '2026-07-03T00:00:00.000Z',
  generatedAt: '2026-07-03T00:00:00.500Z',
};

function mockHappy() {
  apiGetMock.mockResolvedValue({
    data: [{ productId: PRODUCT_A, productName: 'Synapz' }],
  });
  apiPostMock.mockResolvedValue(HAPPY_SCENARIO);
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/console/pricing-scenario']}>
      <Routes>
        <Route path="/console/pricing-scenario" element={<PricingScenario />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function pickProductA(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId('pricing-scenario-page')).toBeInTheDocument();
  });
  const select = screen.getByTestId(
    'pricing-scenario-product',
  ) as HTMLSelectElement;
  await act(async () => {
    fireEvent.change(select, { target: { value: PRODUCT_A } });
  });
}

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mockHappy();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('PricingScenarioInputs (HUB-1670)', () => {
  it('renders sliders + numeric inputs with default 0 values', async () => {
    await act(async () => {
      renderPage();
    });
    await pickProductA();
    expect(
      screen.getByTestId('pricing-scenario-price-slider'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('pricing-scenario-churn-slider'),
    ).toBeInTheDocument();
    expect(
      (screen.getByTestId(
        'pricing-scenario-price-slider',
      ) as HTMLInputElement).value,
    ).toBe('0');
    expect(
      screen.getByTestId('pricing-scenario-price-value').textContent,
    ).toBe('0%');
  });

  it('debounces recompute — POST fires ~300ms after last input change', async () => {
    await act(async () => {
      renderPage();
    });
    await pickProductA();
    // Initial POST for the freshly-picked product fires after the
    // debounce; drain it and reset the mock.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    apiPostMock.mockClear();
    const slider = screen.getByTestId(
      'pricing-scenario-price-slider',
    ) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(slider, { target: { value: '10' } });
    });
    // Immediately after change: no POST yet (still in debounce window).
    expect(apiPostMock).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalled();
    });
    const body = apiPostMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(body.product_id).toBe(PRODUCT_A);
    expect(body.price_change_percent).toBe(10);
    expect(body.churn_assumption_percent).toBe(0);
  });

  it('passes AbortSignal to apiClient.post so in-flight can be cancelled', async () => {
    await act(async () => {
      renderPage();
    });
    await pickProductA();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(apiPostMock).toHaveBeenCalled();
    const opts = apiPostMock.mock.calls[0]![2] as {
      signal?: AbortSignal;
    };
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('shows the loading skeleton while compute is in-flight', async () => {
    let resolveFn: ((v: unknown) => void) | null = null;
    apiPostMock.mockImplementationOnce(
      () => new Promise((res) => {
        resolveFn = res;
      }),
    );
    await act(async () => {
      renderPage();
    });
    await pickProductA();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('pricing-scenario-compute-loading'),
      ).toBeInTheDocument();
    });
    // Resolve to let the promise settle and cleanup run.
    await act(async () => {
      resolveFn?.(HAPPY_SCENARIO);
      await vi.advanceTimersByTimeAsync(0);
    });
  });

  it('shows the compute-ready surface with the results table after fetch', async () => {
    await act(async () => {
      renderPage();
    });
    await pickProductA();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('pricing-scenario-compute-ready'),
      ).toBeInTheDocument();
    });
    // S3's table renders inside the ready container.
    expect(
      screen.getByTestId('pricing-scenario-results-table'),
    ).toBeInTheDocument();
  });

  it('404 PRICING-001 → shows the "no pricing model" resolution surface', async () => {
    apiPostMock.mockRejectedValueOnce(new ApiError(404, 'no_pricing_model'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      renderPage();
    });
    await pickProductA();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('pricing-scenario-no-pricing-model'),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('pricing-scenario-no-pricing-model').textContent,
    ).toContain('no active pricing model');
    errSpy.mockRestore();
  });

  it('generic error → shows the compute-error surface', async () => {
    apiPostMock.mockRejectedValueOnce(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      renderPage();
    });
    await pickProductA();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('pricing-scenario-compute-error'),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('pricing-scenario-compute-error').textContent,
    ).toContain('boom');
    errSpy.mockRestore();
  });
});
