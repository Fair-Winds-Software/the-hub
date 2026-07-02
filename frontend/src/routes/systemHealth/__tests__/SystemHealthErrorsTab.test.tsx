// Authorized by HUB-1677 (E-FE-7 S4) — Errors tab tests. Covers table
// render + window selector switch + row click opens the SideDrawer with
// full detail + audit-explorer deep-link + empty state + axe.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { axe } from 'vitest-axe';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import SystemHealthErrorsTab from '../SystemHealthErrorsTab';

const apiGetMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

const PRODUCT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const ERROR_ROW = {
  id: 'evt-1',
  tenantId: 'tenant-1',
  productId: PRODUCT,
  actorId: '11111111-2222-3333-4444-555555555555',
  eventType: 'auth.login.failure',
  message: 'invalid password from IP 203.0.113.5',
  occurredAt: '2026-06-30T00:00:00.000Z',
};

function mockErrors(errors: unknown[] = [ERROR_ROW]) {
  apiGetMock.mockImplementation((path: string) => {
    if (path.startsWith('/api/v1/admin/system-health/audit-errors')) {
      return Promise.resolve({
        errors,
        generatedAt: '2026-06-30T00:00:00.000Z',
      });
    }
    return Promise.reject(new Error(`unexpected: ${path}`));
  });
}

function renderTab(initial = `/console/system-health/${PRODUCT}/errors`) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route
          path="/console/system-health/:productId/errors"
          element={<SystemHealthErrorsTab />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiGetMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('SystemHealthErrorsTab (HUB-1677)', () => {
  it('renders one row per error with truncated message + short-id actor', async () => {
    mockErrors();
    await act(async () => {
      renderTab();
    });
    await waitFor(() => {
      expect(screen.getByTestId('errors-tab')).toBeInTheDocument();
    });
    expect(screen.getByTestId('errors-row-evt-1')).toBeInTheDocument();
    // Actor short-id first 8 chars
    expect(
      screen.getByTestId('errors-row-evt-1').textContent,
    ).toMatch(/11111111/);
    expect(
      screen.getByTestId('errors-row-evt-1').textContent,
    ).toContain('auth.login.failure');
  });

  it('window selector fires a new GET with windowHours param', async () => {
    mockErrors();
    await act(async () => {
      renderTab();
    });
    await waitFor(() => {
      expect(screen.getByTestId('errors-tab')).toBeInTheDocument();
    });
    apiGetMock.mockClear();
    apiGetMock.mockImplementation((path: string) => {
      if (path.startsWith('/api/v1/admin/system-health/audit-errors')) {
        return Promise.resolve({
          errors: [],
          generatedAt: '2026-06-30T00:00:00.000Z',
        });
      }
      return Promise.reject(new Error('unexpected'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('errors-window-7d'));
      await Promise.resolve();
    });
    const call = apiGetMock.mock.calls[0]![0] as string;
    expect(call).toContain('windowHours=168');
  });

  it('clicking a row opens the SideDrawer + syncs ?eventId to the URL', async () => {
    mockErrors();
    await act(async () => {
      renderTab();
    });
    await waitFor(() => {
      expect(screen.getByTestId('errors-tab')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('errors-row-evt-1'));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByTestId('errors-drawer-evt-1')).toBeInTheDocument();
    });
    // Full untruncated message.
    expect(
      screen.getByTestId('errors-drawer-full-message').textContent,
    ).toBe(ERROR_ROW.message);
    // Audit-explorer deep-link.
    expect(
      screen.getByTestId('errors-drawer-audit-link').getAttribute('href'),
    ).toBe('/console/audit?eventId=evt-1');
  });

  it('deep-link ?eventId=<id> opens the drawer on mount', async () => {
    mockErrors();
    await act(async () => {
      renderTab(
        `/console/system-health/${PRODUCT}/errors?eventId=evt-1`,
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId('errors-drawer-evt-1')).toBeInTheDocument();
    });
  });

  it('empty state renders the "no errors" copy', async () => {
    mockErrors([]);
    await act(async () => {
      renderTab();
    });
    await waitFor(() => {
      expect(screen.getByTestId('errors-tab-empty')).toBeInTheDocument();
    });
  });

  it('passes axe scan with a populated table', async () => {
    mockErrors();
    const { container } = renderTab();
    await waitFor(() => {
      expect(screen.getByTestId('errors-tab')).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});
