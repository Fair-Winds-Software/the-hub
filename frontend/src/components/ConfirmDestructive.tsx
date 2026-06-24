// Authorized by HUB-1575 — canonical two-step destructive-action confirmation (S6 of HUB-1555)
// Inherited tokens from HUB-1571 (Tailwind config). All downstream Epics that perform a
// destructive action (HUB-1562 dashboard freeze, HUB-1564 settings, HUB-1566 +
// HUB-1567 + HUB-1568 wave operator actions) MUST consume this component instead of
// re-implementing the pattern.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { FocusTrap } from 'focus-trap-react';

export interface ConfirmDestructiveProps {
  /** Heading inside the alertdialog. Maps to aria-labelledby. */
  title: string;
  /** Body / description text inside the alertdialog. Maps to aria-describedby. */
  body: string;
  /** Label for the destructive confirm button. Default: "Confirm". */
  confirmLabel?: string;
  /** Label for the cancel button. Default: "Cancel". */
  cancelLabel?: string;
  /**
   * Optional exact-match phrase the operator must type to enable the confirm button.
   * Case-sensitive. When omitted, the confirm button is enabled immediately.
   */
  requirePhrase?: string;
  /** Async destructive action. While pending, the modal disables close affordances. */
  onConfirm: () => Promise<void>;
  /**
   * Render-prop providing an `open()` opener. Trigger element renders inline;
   * its activeElement reference is captured for focus return on close.
   */
  trigger: (open: () => void) => ReactNode;
}

export function ConfirmDestructive({
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  requirePhrase,
  onConfirm,
  trigger,
}: ConfirmDestructiveProps): ReactNode {
  const titleId = useId();
  const bodyId = useId();
  const errorId = useId();
  const phraseInputId = useId();

  const [isOpen, setIsOpen] = useState(false);
  const [typedPhrase, setTypedPhrase] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const phraseInputRef = useRef<HTMLInputElement>(null);

  const phraseMatches = !requirePhrase || typedPhrase === requirePhrase;
  const canConfirm = phraseMatches && !pending;
  const hasTypedSomething = !!requirePhrase && typedPhrase.length > 0;

  const resetState = useCallback(() => {
    setTypedPhrase('');
    setError(null);
    setPending(false);
  }, []);

  const closeAndRestoreFocus = useCallback(() => {
    setIsOpen(false);
    resetState();
    // Return focus to the trigger element per Ironclad Interface a11y.
    queueMicrotask(() => triggerRef.current?.focus());
  }, [resetState]);

  const handleOpen = useCallback(() => {
    triggerRef.current = document.activeElement as HTMLElement | null;
    setIsOpen(true);
  }, []);

  const handleCancel = useCallback(() => {
    if (pending) return;
    closeAndRestoreFocus();
  }, [pending, closeAndRestoreFocus]);

  const handleConfirm = useCallback(async () => {
    if (!canConfirm) return;
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      closeAndRestoreFocus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed. Try again.');
      setPending(false);
    }
  }, [canConfirm, onConfirm, closeAndRestoreFocus]);

  const handleBackdropClick = useCallback(() => {
    if (pending) return; // FR: never close mid-flight
    if (hasTypedSomething) return; // FR: protect typed phrase
    closeAndRestoreFocus();
  }, [pending, hasTypedSomething, closeAndRestoreFocus]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !pending) {
        event.preventDefault();
        closeAndRestoreFocus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen, pending, closeAndRestoreFocus]);

  // Don't render the portal during SSR or when SSR'd in jsdom without document.body.
  if (!isOpen || typeof document === 'undefined') {
    return <>{trigger(handleOpen)}</>;
  }

  const modal = (
    <FocusTrap
      focusTrapOptions={{
        allowOutsideClick: true,
        escapeDeactivates: false,
        // jsdom-friendly: skip element display checks (jsdom can't measure visibility).
        tabbableOptions: { displayCheck: 'none' },
        // First focusable: phrase input ref if present, otherwise default to first tabbable.
        // (Function form avoids CSS-selector issues with useId() colons.)
        initialFocus: requirePhrase
          ? () => phraseInputRef.current ?? false
          : undefined,
      }}
    >
      {/*
        Backdrop. Click is a redundant UX convenience; Escape (handled at window level)
        is the canonical keyboard close affordance. Backdrop is intentionally non-interactive
        for keyboard users — disabling the keyboard-listener rule is the documented intent.
      */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events,jsx-a11y/no-static-element-interactions */}
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-primary-navy/50 motion-reduce:transition-none transition-opacity duration-150"
        onClick={handleBackdropClick}
      >
        {/*
          Dialog. onClick stopPropagation isolates dialog clicks from the backdrop handler;
          the dialog itself is non-interactive in the aria sense (it's the alertdialog container).
        */}
        {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events,jsx-a11y/no-noninteractive-element-interactions */}
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={bodyId}
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-[480px] mx-4 rounded-lg bg-sailcloth p-6 shadow-xl motion-reduce:transition-none transition-transform duration-150"
        >
          <h2 id={titleId} className="font-heading text-xl text-primary-navy mb-3">
            {title}
          </h2>
          <p id={bodyId} className="text-deep-charcoal mb-4">
            {body}
          </p>

          {requirePhrase && (
            <label htmlFor={phraseInputId} className="block mb-4">
              <span className="block text-sm text-deep-charcoal mb-1">
                Type <code className="font-mono bg-primary-navy/5 px-1 rounded">{requirePhrase}</code> to confirm
              </span>
              <input
                ref={phraseInputRef}
                id={phraseInputId}
                type="text"
                value={typedPhrase}
                onChange={(e) => setTypedPhrase(e.target.value)}
                disabled={pending}
                aria-invalid={typedPhrase.length > 0 && !phraseMatches}
                aria-describedby={error ? errorId : undefined}
                className="block w-full rounded-md border border-deep-charcoal/30 px-3 py-2 font-mono text-deep-charcoal focus:outline-none focus:ring-2 focus:ring-primary-navy"
              />
            </label>
          )}

          {error && (
            <div
              id={errorId}
              role="alert"
              className="mb-4 rounded-md bg-ironwake/10 border border-ironwake/30 px-3 py-2 text-sm text-ironwake"
            >
              {error}
            </div>
          )}

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={handleCancel}
              disabled={pending}
              className="rounded-md border border-deep-charcoal/30 bg-sailcloth px-4 py-2 text-deep-charcoal hover:bg-primary-navy/5 focus:outline-none focus:ring-2 focus:ring-primary-navy disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {cancelLabel}
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!canConfirm}
              className="rounded-md bg-ironwake px-4 py-2 text-sailcloth hover:bg-ironwake/90 focus:outline-none focus:ring-2 focus:ring-ironwake disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {pending ? (
                <span aria-live="polite">
                  <span aria-hidden="true" className="inline-block animate-spin mr-2">&#9696;</span>
                  Working&hellip;
                </span>
              ) : (
                confirmLabel
              )}
            </button>
          </div>
        </div>
      </div>
    </FocusTrap>
  );

  return (
    <>
      {trigger(handleOpen)}
      {createPortal(modal, document.body)}
    </>
  );
}
