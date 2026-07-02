// Authorized by HUB-1668 (E-FE-6 S9) — cross-cutting NFR verification for
// the Settings Epic. Locks the RBAC contract (every settings route sits
// behind Settings, and Settings sits behind GuardedRoute(super_admin) in
// App.tsx) via static-source assertion + runs axe-core across each of the
// five sub-routes (S4..S8) with fully-mocked BE.
//
// Deferred cross-cutting items (documented as HUB-1545 tech debt):
//
//   1. showAuditedMutationToast helper: no toast infrastructure with
//      audit-log deep-links exists at v0.1. Each sub-route surfaces its
//      own inline success message instead; the story's audit deep-link
//      UX defers until the shared helper lands.
//
//   2. useFormDraftPersist hook: each modal's local state dismisses on
//      close today. A shared hook that persists in-flight form state
//      across navigation would need every modal refactored to use it;
//      defers until the shared hook lands.
//
//   3. Shared settings-formatters.ts: the pricing-formatters.ts helper
//      (from HUB-1659) already exports formatDate + formatCurrency; the
//      Settings sub-routes reuse those helpers directly rather than
//      duplicate them into a settings-formatters module.
//
// Lighthouse CWV measurement of /console/settings/* routes defers to
// Stage 4 per D-HUB-SCOPE-051 (same in-memory session-store constraint
// as every other post-auth route). CI continues to measure
// /console/login as the canonical cold-load proxy.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
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
import OperatorsManager from '../OperatorsManager';
import HubSettingsManager from '../HubSettingsManager';
import NotificationsManager from '../NotificationsManager';
import EscalationManager from '../EscalationManager';
import WorkflowHooksManager from '../WorkflowHooksManager';
import { useSessionStore } from '../../../stores/sessionStore';

const apiGetMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

const PRODUCT = {
  productId: 'prod-1',
  productName: 'Synapz',
  tenantId: 'tenant-1',
  tenantName: 'Maverick Launch',
};

beforeEach(() => {
  apiGetMock.mockReset();
  apiGetMock.mockImplementation((path: string) => {
    if (path.startsWith('/api/v1/admin/portfolio/products')) {
      return Promise.resolve({ data: [PRODUCT] });
    }
    if (path.startsWith('/api/v1/admin/operators')) {
      return Promise.resolve([]);
    }
    if (path.startsWith('/api/v1/admin/settings')) {
      return Promise.resolve({ settings: {} });
    }
    if (path.startsWith('/api/v1/admin/notifications/')) {
      return Promise.resolve({ channels: [] });
    }
    if (path.startsWith('/api/v1/admin/escalation/')) {
      return Promise.resolve({ rules: [] });
    }
    if (path.startsWith('/api/v1/admin/hooks/')) {
      return Promise.resolve([]);
    }
    return Promise.reject(new Error(`unexpected: ${path}`));
  });
  useSessionStore.setState({
    operator: {
      id: 'op-me',
      email: 'sammy@maverick.launch',
      name: 'Sammy',
      role: 'super_admin',
    },
    isAuthenticated: true,
    isHydrating: false,
    accessToken: 'test',
    refreshToken: 'test-r',
  });
});

afterEach(() => {
  cleanup();
});

describe('Settings NFR verification (HUB-1668)', () => {
  describe('AC#1 — RBAC: every settings sub-route sits behind Settings which is behind GuardedRoute(super_admin)', () => {
    it('static source check: App.tsx wires the settings routes behind super_admin', () => {
      const here = dirname(fileURLToPath(import.meta.url));
      const appPath = resolve(here, '../../../App.tsx');
      const source = readFileSync(appPath, 'utf8');

      // The parent /console/settings route MUST be wrapped by
      // GuardedRoute(super_admin). All sub-routes inherit that guard
      // because they are nested Route children of that element.
      const settingsIdx = source.indexOf('path="/console/settings"');
      expect(settingsIdx).toBeGreaterThan(-1);
      const parentWindow = source.slice(settingsIdx, settingsIdx + 400);
      expect(parentWindow).toContain('requiredRole="super_admin"');

      // The five sub-routes are declared as nested children of that
      // parent Route — locate each by its path.
      for (const subPath of [
        '"operators"',
        '"hub"',
        '"notifications"',
        '"escalation"',
        '"hooks"',
      ]) {
        const idx = source.indexOf(`path=${subPath}`);
        expect(idx).toBeGreaterThan(-1);
        // Sub-route sits after the parent super_admin guard block.
        expect(idx).toBeGreaterThan(settingsIdx);
      }
    });
  });

  describe('AC#3 — axe-core zero violations across S4..S8', () => {
    it('S4 OperatorsManager renders zero violations with empty list', async () => {
      const { container } = render(
        <MemoryRouter>
          <OperatorsManager />
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(
          screen.getByTestId('operators-manager-page'),
        ).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('S5 HubSettingsManager renders zero violations in ready state', async () => {
      const { container } = render(
        <MemoryRouter>
          <HubSettingsManager />
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(screen.getByTestId('hub-settings-page')).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('S6 NotificationsManager renders zero violations after tenant pick', async () => {
      const { container } = render(
        <MemoryRouter>
          <NotificationsManager />
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(screen.getByTestId('notifications-page')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(
          screen.getByTestId('notifications-product-picker'),
          { target: { value: 'prod-1' } },
        );
        await Promise.resolve();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('S7 EscalationManager renders zero violations after product pick', async () => {
      const { container } = render(
        <MemoryRouter>
          <EscalationManager />
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(screen.getByTestId('escalation-page')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(screen.getByTestId('escalation-product-picker'), {
          target: { value: 'prod-1' },
        });
        await Promise.resolve();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('S8 WorkflowHooksManager renders zero violations after tenant pick', async () => {
      const { container } = render(
        <MemoryRouter>
          <WorkflowHooksManager />
        </MemoryRouter>,
      );
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
});
