// Authorized by HUB-1664 (E-FE-6 S5) — HubSettingsManager tests. Covers
// the type-aware editor per FR-010 (number / boolean / string / json),
// the JSON fallback for unknown keys per FR-011 (invalid JSON blocks the
// PUT with an inline error; valid JSON PUTs {key, value: parsed}), and
// per-key discard + save success flow.
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
import HubSettingsManager from '../HubSettingsManager';

const apiGetMock = vi.fn();
const apiPutMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
    put: (...args: unknown[]) => apiPutMock(...args),
  },
}));

function mockSettings(values: Record<string, unknown> = {}) {
  apiGetMock.mockImplementation((path: string) => {
    if (path.startsWith('/api/v1/admin/settings')) {
      return Promise.resolve({ settings: values });
    }
    return Promise.reject(new Error(`unexpected: ${path}`));
  });
}

function renderMgr() {
  return render(
    <MemoryRouter>
      <HubSettingsManager />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiGetMock.mockReset();
  apiPutMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('HubSettingsManager (HUB-1664)', () => {
  it('renders one row per catalog key seeded from the BE response', async () => {
    mockSettings({
      portfolio_margin_threshold_pct: 0.05,
      role_rename_compat_window_enabled: false,
    });
    await act(async () => {
      renderMgr();
    });
    await waitFor(() => {
      expect(screen.getByTestId('hub-settings-page')).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('hub-settings-row-portfolio_margin_threshold_pct'),
    ).toBeInTheDocument();
    // Server value overrides the catalog default.
    expect(
      (screen.getByTestId(
        'hub-settings-input-portfolio_margin_threshold_pct',
      ) as HTMLInputElement).value,
    ).toBe('0.05');
    // Boolean input reads the boolean.
    expect(
      (screen.getByTestId(
        'hub-settings-input-role_rename_compat_window_enabled',
      ) as HTMLInputElement).checked,
    ).toBe(false);
  });

  it('renders unknown keys as raw JSON textarea + labels them clearly', async () => {
    mockSettings({
      unknown_future_key: { arbitrary: true, nested: [1, 2, 3] },
    });
    await act(async () => {
      renderMgr();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('hub-settings-row-unknown_future_key'),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('hub-settings-help-unknown-unknown_future_key'),
    ).toBeInTheDocument();
    const textarea = screen.getByTestId(
      'hub-settings-input-unknown_future_key',
    ) as HTMLTextAreaElement;
    expect(textarea.value).toMatch(/"arbitrary"/);
  });

  describe('number type editor', () => {
    it('saves a valid number and passes the parsed number in the PUT body', async () => {
      mockSettings({ portfolio_margin_threshold_pct: 0.05 });
      apiPutMock.mockResolvedValueOnce({});
      await act(async () => {
        renderMgr();
      });
      await waitFor(() => {
        expect(screen.getByTestId('hub-settings-page')).toBeInTheDocument();
      });
      fireEvent.change(
        screen.getByTestId('hub-settings-input-portfolio_margin_threshold_pct'),
        { target: { value: '0.08' } },
      );
      await act(async () => {
        fireEvent.click(
          screen.getByTestId('hub-settings-save-portfolio_margin_threshold_pct'),
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(apiPutMock).toHaveBeenCalledWith(
        '/api/v1/admin/settings',
        { key: 'portfolio_margin_threshold_pct', value: 0.08 },
      );
      // Success message displayed inline.
      expect(
        screen.getByTestId(
          'hub-settings-save-message-portfolio_margin_threshold_pct',
        ),
      ).toBeInTheDocument();
    });
  });

  describe('json fallback (FR-011)', () => {
    it('invalid JSON blocks the PUT with an inline error', async () => {
      mockSettings({});
      await act(async () => {
        renderMgr();
      });
      await waitFor(() => {
        expect(screen.getByTestId('hub-settings-page')).toBeInTheDocument();
      });
      // jira_project_key_by_product is a known json-typed catalog key.
      const textarea = screen.getByTestId(
        'hub-settings-input-jira_project_key_by_product',
      );
      fireEvent.change(textarea, { target: { value: '{"foo": "bar"' } });
      fireEvent.click(
        screen.getByTestId('hub-settings-save-jira_project_key_by_product'),
      );
      expect(
        screen.getByTestId(
          'hub-settings-error-jira_project_key_by_product',
        ).textContent,
      ).toMatch(/Invalid JSON/);
      expect(apiPutMock).not.toHaveBeenCalled();
    });

    it('valid JSON PUTs the parsed object', async () => {
      mockSettings({});
      apiPutMock.mockResolvedValueOnce({});
      await act(async () => {
        renderMgr();
      });
      await waitFor(() => {
        expect(screen.getByTestId('hub-settings-page')).toBeInTheDocument();
      });
      fireEvent.change(
        screen.getByTestId('hub-settings-input-jira_project_key_by_product'),
        { target: { value: '{"foo": "bar"}' } },
      );
      await act(async () => {
        fireEvent.click(
          screen.getByTestId(
            'hub-settings-save-jira_project_key_by_product',
          ),
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(apiPutMock).toHaveBeenCalledWith(
        '/api/v1/admin/settings',
        {
          key: 'jira_project_key_by_product',
          value: { foo: 'bar' },
        },
      );
    });
  });

  describe('boolean editor', () => {
    it('toggles + saves boolean values as JSON true/false', async () => {
      mockSettings({ role_rename_compat_window_enabled: true });
      apiPutMock.mockResolvedValueOnce({});
      await act(async () => {
        renderMgr();
      });
      await waitFor(() => {
        expect(screen.getByTestId('hub-settings-page')).toBeInTheDocument();
      });
      fireEvent.click(
        screen.getByTestId(
          'hub-settings-input-role_rename_compat_window_enabled',
        ),
      );
      await act(async () => {
        fireEvent.click(
          screen.getByTestId(
            'hub-settings-save-role_rename_compat_window_enabled',
          ),
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(apiPutMock).toHaveBeenCalledWith(
        '/api/v1/admin/settings',
        { key: 'role_rename_compat_window_enabled', value: false },
      );
    });
  });

  describe('discard', () => {
    it('reverts the raw editor to the last server value', async () => {
      mockSettings({ portfolio_margin_threshold_pct: 0.05 });
      await act(async () => {
        renderMgr();
      });
      await waitFor(() => {
        expect(screen.getByTestId('hub-settings-page')).toBeInTheDocument();
      });
      fireEvent.change(
        screen.getByTestId('hub-settings-input-portfolio_margin_threshold_pct'),
        { target: { value: '0.99' } },
      );
      fireEvent.click(
        screen.getByTestId('hub-settings-discard-portfolio_margin_threshold_pct'),
      );
      expect(
        (screen.getByTestId(
          'hub-settings-input-portfolio_margin_threshold_pct',
        ) as HTMLInputElement).value,
      ).toBe('0.05');
    });
  });

  it('passes axe scan in the ready state', async () => {
    mockSettings({ portfolio_margin_threshold_pct: 0.05 });
    const { container } = renderMgr();
    await waitFor(() => {
      expect(screen.getByTestId('hub-settings-page')).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});
