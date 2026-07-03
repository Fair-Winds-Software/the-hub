// Authorized by HUB-1669 (E-FE-11 S1) — shell + picker + empty state
// tests. Full calculator ships in S2/S3/S4.
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
import { PermissionDeniedError } from '../../lib/errors';

const apiGetMock = vi.fn();
vi.mock('../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

const PRODUCT_A = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const PRODUCT_B = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

function mockHappy() {
  apiGetMock.mockResolvedValue({
    data: [
      { productId: PRODUCT_A, productName: 'Synapz' },
      { productId: PRODUCT_B, productName: 'ContentHelm' },
    ],
  });
}

function renderAt(url: string = '/console/pricing-scenario') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/console/pricing-scenario" element={<PricingScenario />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiGetMock.mockReset();
  mockHappy();
});

afterEach(() => {
  cleanup();
});

describe('PricingScenario (HUB-1669)', () => {
  it('renders shell + picker after fetch resolves', async () => {
    await act(async () => {
      renderAt();
    });
    await waitFor(() => {
      expect(screen.getByTestId('pricing-scenario-page')).toBeInTheDocument();
    });
    const select = screen.getByTestId(
      'pricing-scenario-product',
    ) as HTMLSelectElement;
    // Placeholder + 2 products.
    expect(select.options).toHaveLength(3);
    expect(select.options[1]!.textContent).toBe('Synapz');
  });

  it('empty state renders before a product is picked', async () => {
    await act(async () => {
      renderAt();
    });
    await waitFor(() => {
      expect(screen.getByTestId('pricing-scenario-empty')).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('pricing-scenario-empty').textContent,
    ).toContain('Pick a product');
  });

  it('picking a product replaces the empty state with the calculator placeholder', async () => {
    await act(async () => {
      renderAt();
    });
    await waitFor(() => {
      expect(screen.getByTestId('pricing-scenario-empty')).toBeInTheDocument();
    });
    const select = screen.getByTestId(
      'pricing-scenario-product',
    ) as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(select, { target: { value: PRODUCT_A } });
    });
    expect(screen.queryByTestId('pricing-scenario-empty')).toBeNull();
    expect(screen.getByTestId('pricing-scenario-picked')).toBeInTheDocument();
  });

  it('403 → AccessDeniedPage', async () => {
    apiGetMock.mockRejectedValueOnce(new PermissionDeniedError(403, 'no'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      renderAt();
    });
    await waitFor(() => {
      expect(screen.getByTestId('access-denied-page')).toBeInTheDocument();
    });
    errSpy.mockRestore();
  });

  it('fetch throw → error surface with Retry', async () => {
    apiGetMock.mockRejectedValueOnce(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      renderAt();
    });
    await waitFor(() => {
      expect(screen.getByTestId('pricing-scenario-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('pricing-scenario-retry')).toBeInTheDocument();
    errSpy.mockRestore();
  });
});
