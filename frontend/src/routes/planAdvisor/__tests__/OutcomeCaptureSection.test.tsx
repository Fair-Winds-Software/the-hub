// Authorized by HUB-1641 (E-FE-4 S5) — OutcomeCaptureSection tests. Covers the
// 3 outcome buttons + aria-pressed, note textarea + char counter + 1000 char
// cap, localStorage draft persistence, submit success path + onCaptured
// callback + draft clear, submit error inline + buttons stay available, 30-
// day lock state, concurrent-capture detection, and axe-core a11y.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { axe } from 'vitest-axe';
import { OutcomeCaptureSection } from '../OutcomeCaptureSection';

const apiPostMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: {
    post: (...args: unknown[]) => apiPostMock(...args),
  },
}));

const RUN_ID = '00000000-0000-0000-0000-000000000001';

function renderSection(
  props: Partial<React.ComponentProps<typeof OutcomeCaptureSection>> = {},
) {
  const onCaptured = vi.fn();
  const ui = render(
    <OutcomeCaptureSection
      runId={RUN_ID}
      currentOutcome={null}
      currentNote={null}
      outcomeCapturedAt={null}
      onCaptured={onCaptured}
      {...props}
    />,
  );
  return { ...ui, onCaptured };
}

beforeEach(() => {
  apiPostMock.mockReset();
  // Reset localStorage between tests.
  try {
    localStorage.clear();
  } catch {
    // ignore
  }
});

afterEach(() => {
  cleanup();
});

describe('OutcomeCaptureSection (HUB-1641)', () => {
  describe('AC#2 — three outcome buttons rendered', () => {
    it('renders Won / Lost / No action buttons with aria-pressed=false by default', () => {
      renderSection();
      const won = screen.getByTestId('outcome-button-won');
      const lost = screen.getByTestId('outcome-button-lost');
      const noAction = screen.getByTestId('outcome-button-no_action');
      expect(won).toHaveAttribute('aria-pressed', 'false');
      expect(lost).toHaveAttribute('aria-pressed', 'false');
      expect(noAction).toHaveAttribute('aria-pressed', 'false');
    });

    it('clicking a button sets aria-pressed=true on that button only', () => {
      renderSection();
      fireEvent.click(screen.getByTestId('outcome-button-won'));
      expect(
        screen.getByTestId('outcome-button-won'),
      ).toHaveAttribute('aria-pressed', 'true');
      expect(
        screen.getByTestId('outcome-button-lost'),
      ).toHaveAttribute('aria-pressed', 'false');
      expect(
        screen.getByTestId('outcome-button-no_action'),
      ).toHaveAttribute('aria-pressed', 'false');
    });
  });

  describe('AC#3 — note textarea + char counter + cap', () => {
    it('renders the textarea with a paired <label> and char counter (aria-describedby)', () => {
      renderSection();
      const textarea = screen.getByTestId('outcome-note-textarea');
      expect(textarea.tagName).toBe('TEXTAREA');
      expect(textarea.getAttribute('aria-describedby')).toBeTruthy();
      expect(
        screen.getByTestId('outcome-note-char-count').textContent,
      ).toMatch(/0\/1000/);
    });

    it('typing updates the char count', () => {
      renderSection();
      const textarea = screen.getByTestId(
        'outcome-note-textarea',
      ) as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: 'Hello' } });
      expect(
        screen.getByTestId('outcome-note-char-count').textContent,
      ).toMatch(/5\/1000/);
    });

    it('caps input at 1000 chars (defense in depth + maxLength attr)', () => {
      renderSection();
      const textarea = screen.getByTestId(
        'outcome-note-textarea',
      ) as HTMLTextAreaElement;
      const long = 'x'.repeat(1200);
      fireEvent.change(textarea, { target: { value: long } });
      expect(textarea.value.length).toBe(1000);
      expect(textarea).toHaveAttribute('maxlength', '1000');
    });
  });

  describe('AC#3 — note draft persists in localStorage', () => {
    it('persists draft text to localStorage on every change keyed by runId', () => {
      renderSection();
      fireEvent.change(screen.getByTestId('outcome-note-textarea'), {
        target: { value: 'In progress draft' },
      });
      expect(
        localStorage.getItem(`planAdvisor.outcomeNoteDraft.${RUN_ID}`),
      ).toBe('In progress draft');
    });

    it('seeds the textarea from localStorage on mount', () => {
      localStorage.setItem(
        `planAdvisor.outcomeNoteDraft.${RUN_ID}`,
        'saved earlier',
      );
      renderSection();
      expect(
        (screen.getByTestId('outcome-note-textarea') as HTMLTextAreaElement)
          .value,
      ).toBe('saved earlier');
    });
  });

  describe('AC#4/#5 — submit POSTs to the BE outcome endpoint + onCaptured callback', () => {
    it('Save outcome posts {outcome_type, notes} and clears the draft on success', async () => {
      apiPostMock.mockResolvedValue({
        outcomeType: 'won',
        outcomeCapturedAt: '2026-06-30T00:00:00.000Z',
      });
      const { onCaptured } = renderSection();
      fireEvent.click(screen.getByTestId('outcome-button-won'));
      fireEvent.change(screen.getByTestId('outcome-note-textarea'), {
        target: { value: 'Customer signed annual contract.' },
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('outcome-submit-button'));
        await Promise.resolve();
        await Promise.resolve();
      });
      const call = apiPostMock.mock.calls[0];
      expect(call[0]).toBe(
        `/api/v1/admin/advisor/recommendations/${RUN_ID}/outcome`,
      );
      expect(call[1]).toEqual({
        outcome_type: 'won',
        notes: 'Customer signed annual contract.',
      });
      // onCaptured fires with the new outcome + note + capturedAt.
      expect(onCaptured).toHaveBeenCalledWith({
        outcome: 'won',
        note: 'Customer signed annual contract.',
        capturedAt: '2026-06-30T00:00:00.000Z',
      });
      // Draft cleared from localStorage.
      expect(
        localStorage.getItem(`planAdvisor.outcomeNoteDraft.${RUN_ID}`),
      ).toBeNull();
      // Success status announced.
      expect(
        screen.getByTestId('outcome-submit-success'),
      ).toBeInTheDocument();
    });

    it('omits notes from the POST body when the note text is empty', async () => {
      apiPostMock.mockResolvedValue({
        outcomeType: 'lost',
        outcomeCapturedAt: '2026-06-30T00:00:00.000Z',
      });
      renderSection();
      fireEvent.click(screen.getByTestId('outcome-button-lost'));
      await act(async () => {
        fireEvent.click(screen.getByTestId('outcome-submit-button'));
        await Promise.resolve();
        await Promise.resolve();
      });
      const body = apiPostMock.mock.calls[0][1] as Record<string, unknown>;
      expect(body).toEqual({ outcome_type: 'lost' });
      expect(body).not.toHaveProperty('notes');
    });

    it('Save button is disabled until an outcome is picked', () => {
      renderSection();
      expect(
        screen.getByTestId('outcome-submit-button'),
      ).toBeDisabled();
      fireEvent.click(screen.getByTestId('outcome-button-no_action'));
      expect(
        screen.getByTestId('outcome-submit-button'),
      ).not.toBeDisabled();
    });
  });

  describe('AC#9 — submit failure renders inline error + keeps buttons available', () => {
    it('non-network failure surfaces the server message + outcome buttons stay available for retry', async () => {
      const errSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      apiPostMock.mockRejectedValue(
        new Error('OUTCOME_LOCKED: not editable past 30 days'),
      );
      renderSection();
      fireEvent.click(screen.getByTestId('outcome-button-won'));
      await act(async () => {
        fireEvent.click(screen.getByTestId('outcome-submit-button'));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(
        screen.getByTestId('outcome-submit-error').textContent,
      ).toContain('OUTCOME_LOCKED');
      // Buttons remain available + Save still active.
      expect(
        screen.getByTestId('outcome-button-won'),
      ).not.toBeDisabled();
      errSpy.mockRestore();
    });
  });

  describe('AC#6 — 30-day editing window lock', () => {
    it('outcomeCapturedAt within 30 days renders the editable section', () => {
      const within = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
      renderSection({
        currentOutcome: 'won',
        outcomeCapturedAt: within,
      });
      expect(screen.getByTestId('outcome-capture')).toBeInTheDocument();
      // Won button shows aria-pressed=true since the captured outcome is won.
      expect(
        screen.getByTestId('outcome-button-won'),
      ).toHaveAttribute('aria-pressed', 'true');
    });

    it('outcomeCapturedAt > 30 days ago renders the locked state with no buttons', () => {
      const long = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
      renderSection({
        currentOutcome: 'won',
        currentNote: 'auditor cross-reference',
        outcomeCapturedAt: long,
      });
      expect(
        screen.getByTestId('outcome-capture-locked'),
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId('outcome-button-won'),
      ).toBeNull();
      expect(
        screen.getByTestId('outcome-capture-locked').textContent,
      ).toMatch(/Outcome locked/i);
      // Captured outcome + notes still surfaced for audit reference.
      expect(
        screen.getByTestId('outcome-capture-locked').textContent,
      ).toMatch(/won/);
      expect(
        screen.getByTestId('outcome-capture-locked').textContent,
      ).toMatch(/auditor cross-reference/);
    });
  });

  describe('AC#8 — concurrent capture detection', () => {
    it('parent flips currentOutcome from null to a value mid-mount → concurrent state shown', () => {
      const { rerender } = renderSection({ currentOutcome: null });
      // Editable state on first render.
      expect(screen.getByTestId('outcome-capture')).toBeInTheDocument();
      // Simulate parent receiving a fresh fetch showing another operator
      // captured.
      rerender(
        <OutcomeCaptureSection
          runId={RUN_ID}
          currentOutcome="won"
          currentNote={null}
          outcomeCapturedAt={new Date().toISOString()}
          onCaptured={vi.fn()}
        />,
      );
      expect(
        screen.getByTestId('outcome-capture-concurrent'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('outcome-capture-concurrent').textContent,
      ).toMatch(/captured by another operator/i);
    });
  });

  describe('a11y — axe-core zero violations', () => {
    it('passes axe scan in the editable state', async () => {
      const { container } = renderSection();
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('passes axe scan in the locked state', async () => {
      const long = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
      const { container } = renderSection({
        currentOutcome: 'won',
        outcomeCapturedAt: long,
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});
