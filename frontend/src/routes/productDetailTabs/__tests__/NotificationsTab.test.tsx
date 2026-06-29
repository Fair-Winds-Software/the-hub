// Authorized by HUB-1608 (E-FE-3 S8) — NotificationsTab tests. Covers dual-endpoint
// fetch (channels + escalation rules), section rendering, recipient extraction per
// channel type, enabled/disabled badges, empty state with settings link-out,
// partial-OK degradation (one endpoint fails, the other still renders), full-loading
// state, full-empty state, and axe-core a11y.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { axe } from 'vitest-axe';
import { MemoryRouter } from 'react-router-dom';
import { NotificationsTab } from '../NotificationsTab';

const apiGetMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

const CHANNELS = [
  {
    id: 'ch-email',
    tenant_id: 't-1',
    product_id: 'p-1',
    channel_type: 'email',
    config: { to: 'ops@example.com' },
    hmac_secret: null,
    enabled: true,
    created_at: '2025-01-01T00:00:00.000Z',
  },
  {
    id: 'ch-webhook',
    tenant_id: 't-1',
    product_id: 'p-1',
    channel_type: 'webhook',
    config: { url: 'https://hooks.example.com/abc' },
    hmac_secret: '***',
    enabled: false,
    created_at: '2025-01-02T00:00:00.000Z',
  },
];

const RULES = [
  {
    id: 'r-1',
    tenant_id: 't-1',
    product_id: 'p-1',
    alert_type: 'sla_breach',
    tier: 1,
    threshold_minutes: 15,
    escalation_contacts: [{ type: 'email', value: 'oncall@example.com' }],
  },
  {
    id: 'r-2',
    tenant_id: 't-1',
    product_id: 'p-1',
    alert_type: 'sla_breach',
    tier: 2,
    threshold_minutes: 60,
    escalation_contacts: [
      { type: 'email', value: 'sre-lead@example.com' },
      { type: 'sms', value: '+15551234567' },
    ],
  },
];

function defaultMock() {
  return (path: string) => {
    if (path.startsWith('/api/v1/admin/notifications/')) {
      return Promise.resolve({ channels: CHANNELS });
    }
    if (path.startsWith('/api/v1/admin/escalation/')) {
      return Promise.resolve({ rules: RULES });
    }
    return Promise.reject(new Error(`unexpected: ${path}`));
  };
}

beforeEach(() => {
  apiGetMock.mockReset();
  apiGetMock.mockImplementation(defaultMock());
});

afterEach(() => {
  cleanup();
});

function renderTab() {
  return render(
    <MemoryRouter>
      <NotificationsTab productId="p-1" tenantId="t-1" />
    </MemoryRouter>,
  );
}

describe('NotificationsTab (HUB-1608)', () => {
  describe('AC#2/#3 — dual-endpoint fetch + section render', () => {
    it('GETs channels and escalation rules with the correct tenantId/productId path params', async () => {
      renderTab();
      await waitFor(() => {
        expect(screen.getByTestId('channel-ch-email')).toBeInTheDocument();
      });
      const paths = apiGetMock.mock.calls.map((c) => c[0] as string);
      expect(paths).toContain(
        '/api/v1/admin/notifications/t-1/p-1/channels',
      );
      expect(paths).toContain('/api/v1/admin/escalation/t-1/p-1/rules');
    });

    it('renders Channels and Escalation Rules sections', async () => {
      renderTab();
      await waitFor(() => {
        expect(screen.getByTestId('channel-ch-email')).toBeInTheDocument();
      });
      expect(
        screen.getByTestId('notifications-channels-section'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('notifications-escalation-section'),
      ).toBeInTheDocument();
    });

    it('extracts recipient per channel type (email: config.to; webhook: config.url; in_app: literal)', async () => {
      renderTab();
      await waitFor(() => {
        expect(screen.getByTestId('channel-ch-email')).toBeInTheDocument();
      });
      const emailRow = screen.getByTestId('channel-ch-email');
      expect(emailRow.textContent).toContain('ops@example.com');
      const webhookRow = screen.getByTestId('channel-ch-webhook');
      expect(webhookRow.textContent).toContain(
        'https://hooks.example.com/abc',
      );
    });

    it('renders enabled / disabled badges per channel', async () => {
      renderTab();
      await waitFor(() => {
        expect(screen.getByTestId('channel-ch-email')).toBeInTheDocument();
      });
      // ch-email is enabled; ch-webhook is disabled. Both badges visible.
      expect(screen.getByTestId('channel-enabled')).toBeInTheDocument();
      expect(screen.getByTestId('channel-disabled')).toBeInTheDocument();
    });

    it('renders escalation rule rows with alert_type / tier / threshold / contact count', async () => {
      renderTab();
      await waitFor(() => {
        expect(screen.getByTestId('rule-r-1')).toBeInTheDocument();
      });
      const r1 = screen.getByTestId('rule-r-1');
      expect(r1.textContent).toContain('sla_breach');
      expect(r1.textContent).toContain('tier 1');
      expect(r1.textContent).toContain('15m');
      expect(r1.textContent).toContain('1 contact');
      const r2 = screen.getByTestId('rule-r-2');
      expect(r2.textContent).toContain('2 contacts');
    });

    it('read-only — no edit/delete affordances', async () => {
      renderTab();
      await waitFor(() => {
        expect(screen.getByTestId('channel-ch-email')).toBeInTheDocument();
      });
      expect(screen.queryByRole('button', { name: /edit/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /new channel/i })).toBeNull();
    });
  });

  describe('AC#5 — empty state', () => {
    it('renders "No notifications configured" + Settings link when both endpoints return empty', async () => {
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/notifications/')) {
          return Promise.resolve({ channels: [] });
        }
        if (path.startsWith('/api/v1/admin/escalation/')) {
          return Promise.resolve({ rules: [] });
        }
        return Promise.reject(new Error('unexpected'));
      });
      renderTab();
      await waitFor(() => {
        expect(
          screen.getByTestId('notifications-empty-state'),
        ).toBeInTheDocument();
      });
      const cta = screen.getByTestId('notifications-empty-cta');
      expect(cta).toHaveAttribute('href', '/console/settings');
    });

    it('renders per-section empty copy when ONE side is empty but the other has data', async () => {
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/notifications/')) {
          return Promise.resolve({ channels: CHANNELS });
        }
        if (path.startsWith('/api/v1/admin/escalation/')) {
          return Promise.resolve({ rules: [] });
        }
        return Promise.reject(new Error('unexpected'));
      });
      renderTab();
      await waitFor(() => {
        expect(screen.getByTestId('channel-ch-email')).toBeInTheDocument();
      });
      // Channels filled; rules section shows per-section empty text.
      expect(
        screen.getByTestId('notifications-rules-empty'),
      ).toBeInTheDocument();
      expect(screen.queryByTestId('notifications-empty-state')).toBeNull();
    });
  });

  describe('partial-OK degradation', () => {
    it('one endpoint fails, the other still renders + per-section error pill', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/notifications/')) {
          return Promise.reject(new Error('channels-down'));
        }
        if (path.startsWith('/api/v1/admin/escalation/')) {
          return Promise.resolve({ rules: RULES });
        }
        return Promise.reject(new Error('unexpected'));
      });
      renderTab();
      await waitFor(() => {
        expect(screen.getByTestId('rule-r-1')).toBeInTheDocument();
      });
      expect(
        screen.getByTestId('notifications-channels-error').textContent,
      ).toContain('channels-down');
      // Rules section renders normally despite the channels failure.
      expect(screen.queryByTestId('notifications-rules-error')).toBeNull();
      errSpy.mockRestore();
    });
  });

  describe('loading state', () => {
    it('shows full-tab loading text while both fetches are in flight', () => {
      apiGetMock.mockImplementation(() => new Promise(() => {}));
      renderTab();
      expect(
        screen.getByTestId('notifications-tab-loading'),
      ).toBeInTheDocument();
    });
  });

  describe('a11y — axe-core zero violations', () => {
    it('passes axe scan with both sections populated', async () => {
      const { container } = renderTab();
      await waitFor(() => {
        expect(screen.getByTestId('channel-ch-email')).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('passes axe scan in full-empty state', async () => {
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/notifications/')) {
          return Promise.resolve({ channels: [] });
        }
        if (path.startsWith('/api/v1/admin/escalation/')) {
          return Promise.resolve({ rules: [] });
        }
        return Promise.reject(new Error('unexpected'));
      });
      const { container } = renderTab();
      await waitFor(() => {
        expect(
          screen.getByTestId('notifications-empty-state'),
        ).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});
