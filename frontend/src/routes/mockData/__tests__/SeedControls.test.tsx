// Authorized by HUB-1800 (S4 of HUB-1784) — tests for the SeedControls slot component.
// Covers: prompt-tab happy path · preset-tab happy path · error surfacing · Replace mode
// with non-empty snapshot opens the ConfirmDestructive gate · Replace mode with empty
// snapshot skips the confirm gate (nothing to wipe) · submit disabled while busy.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SeedControls } from '../SeedControls';

const PRESETS = [
  { id: 'active-customers-500', label: '500 active customers', description: '500 customers, all active.' },
  { id: 'churned-mix', label: 'Churned mix', description: '200 customers, mixed churn.' },
];

const EMPTY_SNAPSHOT = {
  customers: 0,
  products: 0,
  prices: 0,
  coupons: 0,
  subscriptions: 0,
  invoices: 0,
  discounts: 0,
  balance_transactions: 0,
};
const POPULATED_SNAPSHOT = { ...EMPTY_SNAPSHOT, customers: 3, subscriptions: 3 };

afterEach(() => {
  cleanup();
});

function makeProps(overrides: Partial<React.ComponentProps<typeof SeedControls>> = {}) {
  return {
    snapshot: POPULATED_SNAPSHOT,
    refresh: vi.fn(),
    presetsFetcher: vi.fn().mockResolvedValue({ presets: PRESETS }),
    onPromptSeed: vi.fn().mockResolvedValue({
      plan_summary: { customers: 5 },
      errors: [],
    }),
    onPresetSeed: vi.fn().mockResolvedValue({
      plan_summary: { customers: 500, subscriptions: 500 },
      errors: [],
    }),
    ...overrides,
  };
}

describe('SeedControls — prompt tab', () => {
  it('happy path: submits prompt + mode, renders per-facet counts, calls refresh', async () => {
    const props = makeProps({ snapshot: EMPTY_SNAPSHOT });
    render(<SeedControls {...props} />);
    await waitFor(() => screen.getByTestId('seed-tab-prompt'));
    fireEvent.change(screen.getByTestId('seed-prompt-input'), { target: { value: 'five customers, all active' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('seed-submit'));
    });
    expect(props.onPromptSeed).toHaveBeenCalledWith({
      prompt: 'five customers, all active',
      mode: 'add',
    });
    await waitFor(() => screen.getByTestId('seed-result'));
    expect(screen.getByTestId('seed-result-customers').textContent).toContain('5');
    expect(props.refresh).toHaveBeenCalledOnce();
  });

  it('submit is disabled when the prompt is under 5 chars', async () => {
    const props = makeProps({ snapshot: EMPTY_SNAPSHOT });
    render(<SeedControls {...props} />);
    await waitFor(() => screen.getByTestId('seed-tab-prompt'));
    fireEvent.change(screen.getByTestId('seed-prompt-input'), { target: { value: 'hi' } });
    expect((screen.getByTestId('seed-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('surfaces backend error message as an alert', async () => {
    const props = makeProps({
      snapshot: EMPTY_SNAPSHOT,
      onPromptSeed: vi.fn().mockRejectedValue(new Error('LLM response did not match')),
    });
    render(<SeedControls {...props} />);
    await waitFor(() => screen.getByTestId('seed-tab-prompt'));
    fireEvent.change(screen.getByTestId('seed-prompt-input'), { target: { value: 'valid prompt' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('seed-submit'));
    });
    await waitFor(() => screen.getByTestId('seed-error'));
    expect(screen.getByTestId('seed-error').textContent).toContain('LLM response did not match');
  });
});

describe('SeedControls — preset tab', () => {
  it('happy path: selects preset, submits, renders result', async () => {
    const props = makeProps({ snapshot: EMPTY_SNAPSHOT });
    render(<SeedControls {...props} />);
    fireEvent.click(screen.getByTestId('seed-tab-preset'));
    // Poll until the presets fetch resolves and populates the picker with a default value.
    await waitFor(() => {
      const picker = screen.getByTestId('seed-preset-picker') as HTMLSelectElement;
      expect(picker.value).toBe('active-customers-500');
    });
    expect(screen.getByTestId('seed-preset-description').textContent).toContain('all active');

    await act(async () => {
      fireEvent.click(screen.getByTestId('seed-submit'));
    });
    expect(props.onPresetSeed).toHaveBeenCalledWith({
      preset_id: 'active-customers-500',
      mode: 'add',
    });
    await waitFor(() => screen.getByTestId('seed-result'));
    expect(screen.getByTestId('seed-result-customers').textContent).toContain('500');
    expect(screen.getByTestId('seed-result-subscriptions').textContent).toContain('500');
  });

  it('preset dropdown lists every preset returned by the presetsFetcher', async () => {
    const props = makeProps();
    render(<SeedControls {...props} />);
    fireEvent.click(screen.getByTestId('seed-tab-preset'));
    await waitFor(() => {
      const picker = screen.getByTestId('seed-preset-picker') as HTMLSelectElement;
      const options = Array.from(picker.querySelectorAll('option')).map((o) => o.value);
      expect(options).toEqual(['active-customers-500', 'churned-mix']);
    });
  });
});

describe('SeedControls — Replace-mode confirmation gate', () => {
  it('opens ConfirmDestructive when Replace + non-empty snapshot; onPromptSeed not called until confirm', async () => {
    const props = makeProps({ snapshot: POPULATED_SNAPSHOT });
    render(<SeedControls {...props} />);
    await waitFor(() => screen.getByTestId('seed-tab-prompt'));
    fireEvent.change(screen.getByTestId('seed-prompt-input'), { target: { value: 'valid prompt' } });
    fireEvent.click(screen.getByTestId('seed-mode-replace'));
    // Click submit — should open the confirm dialog rather than immediately POST.
    await act(async () => {
      fireEvent.click(screen.getByTestId('seed-submit'));
    });
    expect(props.onPromptSeed).not.toHaveBeenCalled();
    // Confirm dialog should be visible with the destructive alertdialog role.
    await waitFor(() => screen.getByRole('alertdialog'));
    // Click the confirm button.
    const confirmBtn = screen.getByRole('button', { name: /yes, replace and seed/i });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });
    await waitFor(() => {
      expect(props.onPromptSeed).toHaveBeenCalledOnce();
    });
    expect(props.onPromptSeed).toHaveBeenCalledWith({
      prompt: 'valid prompt',
      mode: 'replace',
    });
  });

  it('Replace mode with EMPTY snapshot skips the confirm gate (nothing to wipe)', async () => {
    const props = makeProps({ snapshot: EMPTY_SNAPSHOT });
    render(<SeedControls {...props} />);
    await waitFor(() => screen.getByTestId('seed-tab-prompt'));
    fireEvent.change(screen.getByTestId('seed-prompt-input'), { target: { value: 'valid prompt' } });
    fireEvent.click(screen.getByTestId('seed-mode-replace'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('seed-submit'));
    });
    // No dialog opens — the request fires directly.
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => {
      expect(props.onPromptSeed).toHaveBeenCalledWith({
        prompt: 'valid prompt',
        mode: 'replace',
      });
    });
  });
});
