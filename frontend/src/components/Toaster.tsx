// Authorized by HUB-1578 — Toaster renderer for the Operator Console (S9 of HUB-1555).
// Reads from toastStore; renders 1 toast per item; auto-dismisses after autoDismissMs (5000ms
// default) WHEN prefers-reduced-motion is NOT reduce. With reduce, no auto-dismiss — operator
// must dismiss manually (FR + a11y AC).
import { useEffect, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useToasts, useToastStore, type Toast } from '../stores/toastStore';

const DEFAULT_AUTO_DISMISS_MS = 5000;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent): void => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

interface ToastCardProps {
  toast: Toast;
  reducedMotion: boolean;
  onDismiss: (id: string) => void;
}

function ToastCard({ toast, reducedMotion, onDismiss }: ToastCardProps): ReactNode {
  const variantClasses: Record<Toast['variant'], string> = {
    info: 'bg-secondary-blue/10 border-secondary-blue/40 text-deep-charcoal',
    success: 'bg-seafoam/10 border-seafoam/40 text-deep-charcoal',
    warning: 'bg-accent-brass/15 border-accent-brass/50 text-deep-charcoal',
    error: 'bg-ironwake/10 border-ironwake/40 text-ironwake',
  };

  useEffect(() => {
    if (reducedMotion) return; // FR + a11y: no auto-dismiss under prefers-reduced-motion
    const ms = toast.autoDismissMs ?? DEFAULT_AUTO_DISMISS_MS;
    const timer = window.setTimeout(() => onDismiss(toast.id), ms);
    return () => window.clearTimeout(timer);
  }, [toast.id, toast.autoDismissMs, reducedMotion, onDismiss]);

  return (
    <div
      data-testid={`toast-${toast.id}`}
      data-variant={toast.variant}
      className={`pointer-events-auto flex items-start gap-2 rounded-md border px-3 py-2 shadow-md min-w-[260px] max-w-[400px] ${variantClasses[toast.variant]}`}
    >
      <span className="flex-1 font-body text-sm">{toast.message}</span>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss"
        className="rounded-sm p-0.5 hover:bg-deep-charcoal/10 focus:outline-none focus:ring-2 focus:ring-primary-navy"
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

export function Toaster(): ReactNode {
  const toasts = useToasts();
  const dismissToast = useToastStore((s) => s.dismissToast);
  const reducedMotion = usePrefersReducedMotion();

  if (toasts.length === 0) return null;

  // Split: warning/error use role="alert" (assertive), info/success use role="status" (polite).
  const assertive = toasts.filter((t) => t.variant === 'warning' || t.variant === 'error');
  const polite = toasts.filter((t) => t.variant === 'info' || t.variant === 'success');

  const positionClasses =
    'fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none';

  return (
    <>
      {polite.length > 0 && (
        <div
          role="status"
          aria-live="polite"
          aria-atomic="false"
          data-testid="toaster-polite"
          className={positionClasses}
        >
          {polite.map((t) => (
            <ToastCard
              key={t.id}
              toast={t}
              reducedMotion={reducedMotion}
              onDismiss={dismissToast}
            />
          ))}
        </div>
      )}
      {assertive.length > 0 && (
        <div
          role="alert"
          aria-live="assertive"
          aria-atomic="false"
          data-testid="toaster-assertive"
          className={`${positionClasses} bottom-20`}
        >
          {assertive.map((t) => (
            <ToastCard
              key={t.id}
              toast={t}
              reducedMotion={reducedMotion}
              onDismiss={dismissToast}
            />
          ))}
        </div>
      )}
    </>
  );
}
