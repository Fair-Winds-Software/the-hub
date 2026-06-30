// Authorized by HUB-1641 (E-FE-4 S5) — Outcome capture section. Operator records
// Won / Lost / No action plus an optional note; submit POSTs to the BE outcome
// endpoint. Outcome is editable up to 30 days after the initial capture; after
// that the section locks. Note drafts persist in localStorage keyed by runId so
// accidental navigation doesn't lose typed input.
//
// Spec deviations (documented per ironclad-engineer):
// 1. Endpoint: spec named POST /api/v1/admin/plan-advisor/runs/:runId/outcome.
//    Canonical BE surface is POST /api/v1/admin/advisor/recommendations/:id/
//    outcome (HUB-1144) with body { outcome_type, outcome_value?, notes? }.
//    Note field is `notes` not `note`.
// 2. Concurrent capture (AC#8): the spec calls for detecting another
//    operator's capture between view-load and submit. At v0.1 we surface the
//    'captured by another operator' state when the parent's currentOutcome
//    changes from null to a value while the section is mounted with no
//    pending submit. Full live-sync against BE is deferred to HUB-1545
//    Tech Debt — this satisfies the AC for the read-after-write case the
//    parent already handles via the onCaptured callback.
//
// Note draft persistence: localStorage key 'planAdvisor.outcomeNoteDraft.<runId>'.
// Draft is cleared on successful submit so the next visit starts fresh.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { apiClient } from '../../lib/api';

const OUTCOME_PATH = (runId: string): string =>
  `/api/v1/admin/advisor/recommendations/${runId}/outcome`;
const NOTE_MAX = 1000;
const EDIT_WINDOW_DAYS = 30;
const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

export type CapturableOutcome = 'won' | 'lost' | 'no_action';

const OUTCOME_BUTTONS: Array<{
  value: CapturableOutcome;
  label: string;
  variant: 'primary' | 'secondary' | 'tertiary';
}> = [
  {
    value: 'won',
    label: 'Won (customer accepted)',
    variant: 'primary',
  },
  {
    value: 'lost',
    label: 'Lost (customer declined)',
    variant: 'secondary',
  },
  {
    value: 'no_action',
    label: 'No action taken',
    variant: 'tertiary',
  },
];

const VARIANT_CLASS: Record<'primary' | 'secondary' | 'tertiary', string> = {
  primary:
    'border-seafoam/40 text-seafoam hover:bg-seafoam/10 aria-pressed:bg-seafoam aria-pressed:text-sailcloth',
  secondary:
    'border-ironwake/40 text-ironwake hover:bg-ironwake/10 aria-pressed:bg-ironwake aria-pressed:text-sailcloth',
  tertiary:
    'border-deep-charcoal/30 text-deep-charcoal hover:bg-deep-charcoal/10 aria-pressed:bg-deep-charcoal/80 aria-pressed:text-sailcloth',
};

interface OutcomeResponse {
  outcomeType?: CapturableOutcome;
  outcomeCapturedAt?: string;
  notes?: string;
}

export interface OutcomeCaptureSectionProps {
  runId: string;
  currentOutcome: CapturableOutcome | string | null;
  currentNote: string | null;
  outcomeCapturedAt: string | null;
  onCaptured: (next: {
    outcome: CapturableOutcome;
    note: string;
    capturedAt: string;
  }) => void;
}

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'error'; message: string }
  | { kind: 'success'; outcome: CapturableOutcome };

function draftKey(runId: string): string {
  return `planAdvisor.outcomeNoteDraft.${runId}`;
}

function readDraft(runId: string): string {
  try {
    return localStorage.getItem(draftKey(runId)) ?? '';
  } catch {
    return '';
  }
}

function writeDraft(runId: string, value: string): void {
  try {
    if (value.length === 0) localStorage.removeItem(draftKey(runId));
    else localStorage.setItem(draftKey(runId), value);
  } catch {
    // Quota / disabled storage — non-fatal.
  }
}

function daysSince(iso: string | null): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return 0;
  return (Date.now() - t) / MILLIS_PER_DAY;
}

function isCapturable(value: unknown): value is CapturableOutcome {
  return value === 'won' || value === 'lost' || value === 'no_action';
}

export function OutcomeCaptureSection({
  runId,
  currentOutcome,
  currentNote,
  outcomeCapturedAt,
  onCaptured,
}: OutcomeCaptureSectionProps): React.ReactElement {
  const noteId = useId();
  const charCountId = useId();
  const lockedId = useId();
  const [pendingOutcome, setPendingOutcome] = useState<
    CapturableOutcome | null
  >(isCapturable(currentOutcome) ? currentOutcome : null);
  const [noteText, setNoteText] = useState<string>(() => {
    const draft = readDraft(runId);
    if (draft) return draft;
    return currentNote ?? '';
  });
  const [submit, setSubmit] = useState<SubmitState>({ kind: 'idle' });
  // Track the outcome at mount so we can detect a concurrent capture by
  // another operator while this section is open.
  const initialOutcomeRef = useRef<CapturableOutcome | string | null>(
    currentOutcome,
  );

  // Persist drafts on every change.
  useEffect(() => {
    writeDraft(runId, noteText);
  }, [runId, noteText]);

  const ageDays = daysSince(outcomeCapturedAt);
  const isLocked = outcomeCapturedAt !== null && ageDays > EDIT_WINDOW_DAYS;
  const concurrentCaptureDetected =
    initialOutcomeRef.current === null &&
    isCapturable(currentOutcome) &&
    submit.kind !== 'submitting' &&
    submit.kind !== 'success' &&
    pendingOutcome === null;

  const handleOutcomePick = useCallback(
    (value: CapturableOutcome) => {
      if (isLocked || concurrentCaptureDetected) return;
      setPendingOutcome(value);
      setSubmit({ kind: 'idle' });
    },
    [isLocked, concurrentCaptureDetected],
  );

  const handleNoteChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      const next = event.target.value.slice(0, NOTE_MAX);
      setNoteText(next);
    },
    [],
  );

  const submitOutcome = useCallback(async (): Promise<void> => {
    if (!pendingOutcome) return;
    setSubmit({ kind: 'submitting' });
    try {
      const body: Record<string, unknown> = {
        outcome_type: pendingOutcome,
      };
      if (noteText.trim().length > 0) body.notes = noteText.trim();
      const res = await apiClient.post<OutcomeResponse>(
        OUTCOME_PATH(runId),
        body,
      );
      const capturedAt = res.outcomeCapturedAt ?? new Date().toISOString();
      // Clear the draft on success.
      writeDraft(runId, '');
      onCaptured({
        outcome: pendingOutcome,
        note: noteText,
        capturedAt,
      });
      setSubmit({ kind: 'success', outcome: pendingOutcome });
      initialOutcomeRef.current = pendingOutcome;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unable to save outcome. Retry?';
      setSubmit({ kind: 'error', message });
    }
  }, [pendingOutcome, noteText, onCaptured, runId]);

  if (isLocked) {
    return (
      <section
        aria-labelledby={lockedId}
        data-testid="outcome-capture-locked"
        className="rounded-md border border-deep-charcoal/20 bg-deep-charcoal/5 p-4"
      >
        <h2
          id={lockedId}
          className="font-heading text-lg text-primary-navy mb-2"
        >
          Outcome
        </h2>
        <p
          role="status"
          aria-live="polite"
          className="text-sm font-body text-deep-charcoal/80"
        >
          Outcome locked (captured{' '}
          {new Date(outcomeCapturedAt!).toLocaleDateString()} —{' '}
          {Math.floor(ageDays)} days ago, past the {EDIT_WINDOW_DAYS}-day
          editing window).
        </p>
        {isCapturable(currentOutcome) && (
          <p className="mt-2 text-sm font-body text-deep-charcoal">
            Captured outcome: <strong>{currentOutcome}</strong>
          </p>
        )}
        {currentNote && (
          <p className="mt-2 text-sm font-body text-deep-charcoal/80">
            Notes: {currentNote}
          </p>
        )}
      </section>
    );
  }

  if (concurrentCaptureDetected && isCapturable(currentOutcome)) {
    return (
      <section
        aria-labelledby="outcome-capture-concurrent-heading"
        data-testid="outcome-capture-concurrent"
        className="rounded-md border border-accent-brass/40 bg-accent-brass/5 p-4"
      >
        <h2
          id="outcome-capture-concurrent-heading"
          className="font-heading text-lg text-accent-brass mb-2"
        >
          Outcome captured by another operator
        </h2>
        <p
          role="alert"
          className="text-sm font-body text-accent-brass"
        >
          Captured outcome: <strong>{currentOutcome}</strong>
          {outcomeCapturedAt &&
            ` at ${new Date(outcomeCapturedAt).toLocaleString()}`}
          . Refresh to clear this notice and review the captured state.
        </p>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="outcome-capture-heading"
      data-testid="outcome-capture"
      className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-4"
    >
      <h2
        id="outcome-capture-heading"
        className="font-heading text-lg text-primary-navy mb-3"
      >
        Outcome
      </h2>
      <div className="flex flex-wrap gap-2">
        {OUTCOME_BUTTONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            data-testid={`outcome-button-${opt.value}`}
            aria-pressed={pendingOutcome === opt.value}
            onClick={() => handleOutcomePick(opt.value)}
            disabled={submit.kind === 'submitting'}
            className={`rounded-md border px-3 py-1.5 text-sm font-body shadow-sm focus:outline-none focus:ring-2 focus:ring-accent-brass disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT_CLASS[opt.variant]}`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <div className="mt-3 flex flex-col gap-1">
        <label
          htmlFor={noteId}
          className="font-body text-sm text-deep-charcoal/80"
        >
          Notes (optional)
        </label>
        <textarea
          id={noteId}
          data-testid="outcome-note-textarea"
          value={noteText}
          onChange={handleNoteChange}
          maxLength={NOTE_MAX}
          rows={3}
          aria-describedby={charCountId}
          disabled={submit.kind === 'submitting'}
          className="rounded border border-deep-charcoal/20 bg-white p-2 text-sm font-body text-deep-charcoal focus:outline-none focus:ring-2 focus:ring-accent-brass disabled:cursor-not-allowed"
        />
        <span
          id={charCountId}
          data-testid="outcome-note-char-count"
          className="font-body text-xs text-deep-charcoal/60"
        >
          {noteText.length}/{NOTE_MAX} characters
        </span>
      </div>

      {submit.kind === 'error' && (
        <div
          role="alert"
          data-testid="outcome-submit-error"
          className="mt-3 rounded-md border border-ironwake/40 bg-ironwake/5 p-2 text-sm font-body text-ironwake"
        >
          {submit.message}
        </div>
      )}

      {submit.kind === 'success' && (
        <div
          role="status"
          aria-live="polite"
          data-testid="outcome-submit-success"
          className="mt-3 rounded-md border border-seafoam/40 bg-seafoam/5 p-2 text-sm font-body text-seafoam"
        >
          Outcome captured: <strong>{submit.outcome}</strong>
        </div>
      )}

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          data-testid="outcome-submit-button"
          onClick={() => void submitOutcome()}
          disabled={pendingOutcome === null || submit.kind === 'submitting'}
          className="inline-flex items-center rounded-md bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth shadow-sm hover:bg-primary-navy/90 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          {submit.kind === 'submitting' ? 'Saving…' : 'Save outcome'}
        </button>
      </div>
    </section>
  );
}
