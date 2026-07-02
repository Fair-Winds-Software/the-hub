// Authorized by HUB-1667 (E-FE-6 S8) — WorkflowHooksManager tests. Covers
// tenant picker derived from the portfolio + hooks list load, New Hook
// modal validation (HTTPS-only URL + required secret), POST payload
// shape (nested action_config), Archive two-step confirm + DELETE,
// executions expand + StatusPill triple-encoding, and axe.
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
import { MemoryRouter } from 'react-router-dom';
import WorkflowHooksManager from '../WorkflowHooksManager';

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
const apiDeleteMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
    post: (...args: unknown[]) => apiPostMock(...args),
    delete: (...args: unknown[]) => apiDeleteMock(...args),
  },
}));

const PRODUCT = {
  productId: 'prod-1',
  productName: 'Synapz',
  tenantId: 'tenant-1',
  tenantName: 'Maverick Launch',
};

const HOOK = {
  id: 'hook-1',
  tenant_id: 'tenant-1',
  product_id: null,
  trigger_event_type: 'payment_failed',
  action_type: 'webhook',
  action_config: { url: 'https://example.com/webhook', hmac_secret: '***' },
  enabled: true,
  archived_at: null,
  created_at: '2026-06-01T00:00:00.000Z',
};

const EXEC_OK = {
  id: 'exec-ok',
  hook_id: 'hook-1',
  alert_event_id: 'evt-1',
  status: 'delivered',
  status_code: 200,
  duration_ms: 120,
  error: null,
  attempted_at: '2026-06-10T00:00:00.000Z',
};

const EXEC_5XX = {
  ...EXEC_OK,
  id: 'exec-5xx',
  status: 'failed',
  status_code: 502,
  error: 'Bad gateway',
  attempted_at: '2026-06-09T00:00:00.000Z',
};

function mockPortfolioAndHooks(hooks: unknown[] = [HOOK], executions: unknown[] = []) {
  apiGetMock.mockImplementation((path: string) => {
    if (path.startsWith('/api/v1/admin/portfolio/products')) {
      return Promise.resolve({ data: [PRODUCT] });
    }
    if (path.match(/^\/api\/v1\/admin\/hooks\/[^/]+\/[^/]+\/executions$/)) {
      return Promise.resolve(executions);
    }
    if (path.startsWith('/api/v1/admin/hooks/')) {
      return Promise.resolve(hooks);
    }
    return Promise.reject(new Error(`unexpected: ${path}`));
  });
}

function renderMgr() {
  return render(
    <MemoryRouter>
      <WorkflowHooksManager />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  apiDeleteMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('WorkflowHooksManager (HUB-1667)', () => {
  it('renders the tenant picker seeded from the portfolio', async () => {
    mockPortfolioAndHooks();
    await act(async () => {
      renderMgr();
    });
    await waitFor(() => {
      expect(screen.getByTestId('hooks-page')).toBeInTheDocument();
    });
    const picker = screen.getByTestId('hooks-tenant-picker') as HTMLSelectElement;
    const labels = Array.from(picker.querySelectorAll('option')).map(
      (o) => o.textContent,
    );
    expect(labels).toContain('Maverick Launch');
  });

  it('selecting a tenant loads its hooks and renders one row per hook', async () => {
    mockPortfolioAndHooks([HOOK]);
    await act(async () => {
      renderMgr();
    });
    await waitFor(() => {
      expect(screen.getByTestId('hooks-page')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId('hooks-tenant-picker'), {
        target: { value: 'tenant-1' },
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByTestId('hooks-row-hook-1')).toBeInTheDocument();
    });
  });

  describe('New Hook modal', () => {
    it('rejects a non-HTTPS URL + missing secret with inline errors', async () => {
      mockPortfolioAndHooks([]);
      await act(async () => {
        renderMgr();
      });
      await waitFor(() => {
        expect(screen.getByTestId('hooks-page')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(screen.getByTestId('hooks-tenant-picker'), {
          target: { value: 'tenant-1' },
        });
        await Promise.resolve();
      });
      fireEvent.click(screen.getByTestId('hooks-new'));
      fireEvent.change(screen.getByTestId('new-hook-trigger'), {
        target: { value: 'payment_failed' },
      });
      fireEvent.change(screen.getByTestId('new-hook-url'), {
        target: { value: 'http://insecure.example.com/webhook' },
      });
      fireEvent.click(screen.getByTestId('new-hook-submit'));
      expect(screen.getByTestId('new-hook-url-err').textContent).toMatch(
        /https:\/\//,
      );
      expect(screen.getByTestId('new-hook-secret-err')).toBeInTheDocument();
      expect(apiPostMock).not.toHaveBeenCalled();
    });

    it('valid inputs POST the nested action_config body to the tenant-scoped endpoint', async () => {
      mockPortfolioAndHooks([]);
      apiPostMock.mockResolvedValueOnce({});
      await act(async () => {
        renderMgr();
      });
      await waitFor(() => {
        expect(screen.getByTestId('hooks-page')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(screen.getByTestId('hooks-tenant-picker'), {
          target: { value: 'tenant-1' },
        });
        await Promise.resolve();
      });
      fireEvent.click(screen.getByTestId('hooks-new'));
      fireEvent.change(screen.getByTestId('new-hook-trigger'), {
        target: { value: 'payment_failed' },
      });
      fireEvent.change(screen.getByTestId('new-hook-url'), {
        target: { value: 'https://example.com/webhook' },
      });
      fireEvent.change(screen.getByTestId('new-hook-secret'), {
        target: { value: 'sekret-42' },
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('new-hook-submit'));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(apiPostMock).toHaveBeenCalledWith(
        '/api/v1/admin/hooks/tenant-1',
        {
          trigger_event_type: 'payment_failed',
          action_config: {
            url: 'https://example.com/webhook',
            hmac_secret: 'sekret-42',
          },
          enabled: true,
        },
      );
    });
  });

  describe('Executions expand', () => {
    it('toggles the executions panel + shows a StatusPill per code', async () => {
      mockPortfolioAndHooks([HOOK], [EXEC_OK, EXEC_5XX]);
      await act(async () => {
        renderMgr();
      });
      await waitFor(() => {
        expect(screen.getByTestId('hooks-page')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(screen.getByTestId('hooks-tenant-picker'), {
          target: { value: 'tenant-1' },
        });
        await Promise.resolve();
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('hooks-toggle-execs-hook-1'));
        await Promise.resolve();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('hook-executions-list-hook-1'),
        ).toBeInTheDocument();
      });
      expect(screen.getByTestId('hook-exec-status-200')).toBeInTheDocument();
      expect(screen.getByTestId('hook-exec-status-502')).toBeInTheDocument();
      // The 5xx execution surfaces the error field.
      expect(
        screen.getByTestId('hook-execution-error-exec-5xx').textContent,
      ).toMatch(/Bad gateway/);
    });
  });

  describe('Archive two-step confirm', () => {
    it('first Continue reveals the confirm panel; second click DELETEs', async () => {
      mockPortfolioAndHooks([HOOK]);
      apiDeleteMock.mockResolvedValueOnce({});
      await act(async () => {
        renderMgr();
      });
      await waitFor(() => {
        expect(screen.getByTestId('hooks-page')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(screen.getByTestId('hooks-tenant-picker'), {
          target: { value: 'tenant-1' },
        });
        await Promise.resolve();
      });
      fireEvent.click(screen.getByTestId('hooks-archive-hook-1'));
      fireEvent.click(screen.getByTestId('archive-hook-confirm'));
      expect(
        screen.getByTestId('archive-hook-confirm-panel'),
      ).toBeInTheDocument();
      expect(apiDeleteMock).not.toHaveBeenCalled();
      await act(async () => {
        fireEvent.click(screen.getByTestId('archive-hook-confirm'));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(apiDeleteMock).toHaveBeenCalledWith(
        '/api/v1/admin/hooks/tenant-1/hook-1',
      );
    });
  });

  it('passes axe scan in the tenant + list state', async () => {
    mockPortfolioAndHooks([HOOK]);
    const { container } = renderMgr();
    await waitFor(() => {
      expect(screen.getByTestId('hooks-page')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId('hooks-tenant-picker'), {
        target: { value: 'tenant-1' },
      });
      await Promise.resolve();
    });
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});
