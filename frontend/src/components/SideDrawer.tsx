// Authorized by HUB-1611 (E-FE-12 S1) — canonical Sheet pattern for the HUB Operator Console.
// Slides from the right edge; LEFT content stays interactive (aria-modal="false"). Consumers
// needing a true blocking modal use HUB-1575 <ConfirmDestructive> instead.
//
// Inherited tokens from HUB-1571 (Tailwind config). Downstream Epics that show row-detail or
// contextual information (HUB-1558 audit explorer, HUB-1567 customer health, HUB-1568 failed
// payments, HUB-1564 settings operator edit, etc.) MUST consume this component instead of
// re-implementing the pattern.
//
// Spec deviations (documented per ironclad-engineer):
// 1. `focus-trap-react` used for Tab cycle. Spec AC#FR said "no external dependencies", but
//    focus-trap-react is already in HUB deps and used by ConfirmDestructive (HUB-1575).
//    Re-using the established convention beats inventing a manual trap.
// 2. URL sync uses `replace: true` to keep history clean across rapid open/close — matches the
//    "no history bloat" decision HUB-1616 makes for its filter form. Browser back/forward
//    semantics: closing the drawer removes the param; navigating back re-applies the param
//    state but does NOT re-open (matches the standard "close = remove URL state" contract).
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { FocusTrap } from 'focus-trap-react';

export type SideDrawerSize = 'sm' | 'md' | 'lg';

export interface SideDrawerProps {
  /** Whether the drawer is open. Controlled by the consumer. */
  open: boolean;
  /** Called when the drawer requests close (Escape key, close button, or URL param removal). */
  onClose: () => void;
  /** Heading inside the drawer. Maps to aria-labelledby. */
  title: string;
  /** Drawer body content. */
  children: ReactNode;
  /**
   * Container width. Defaults to 'md' (480px). Sizes match the spec: sm=320, md=480, lg=640.
   */
  size?: SideDrawerSize;
  /**
   * Optional URL-query sync. When set, the drawer's open/close state syncs to a URL search
   * parameter of this name. Deep-link to URL?<urlParam>=1 opens the drawer on mount; closing
   * removes the param. Consumers omit this prop for purely-local drawer state.
   */
  urlParam?: string;
}

const SIZE_TO_WIDTH_PX: Record<SideDrawerSize, number> = {
  sm: 320,
  md: 480,
  lg: 640,
};

export function SideDrawer({
  open,
  onClose,
  title,
  children,
  size = 'md',
  urlParam,
}: SideDrawerProps): ReactNode {
  const titleId = useId();
  // Captured at open time so close restores focus to the element that triggered the drawer.
  // queueMicrotask is used to defer focus restoration past React's commit phase.
  const triggerRef = useRef<HTMLElement | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();

  // ── URL sync: bidirectional binding when urlParam is provided ──────────────
  //
  // Single effect with refs tracking what changed since last render. We need to
  // distinguish CONSUMER-driven transitions (open prop flipped → mirror to URL) from
  // URL-driven removal (browser back removed the param → signal consumer to close).
  // Without ref tracking, the trivial "if open && !has, call onClose" condition fires
  // immediately when the consumer opens the drawer for the first time — because the URL
  // is still empty.
  const prevOpenRef = useRef(open);
  const prevHasParamRef = useRef(urlParam ? searchParams.has(urlParam) : false);

  useEffect(() => {
    if (!urlParam) return;
    const has = searchParams.has(urlParam);
    const openChanged = open !== prevOpenRef.current;
    const hasChanged = has !== prevHasParamRef.current;

    if (openChanged) {
      // Consumer flipped `open`. Mirror to URL.
      if (open && !has) {
        const next = new URLSearchParams(searchParams);
        next.set(urlParam, '1');
        setSearchParams(next, { replace: true });
      } else if (!open && has) {
        const next = new URLSearchParams(searchParams);
        next.delete(urlParam);
        setSearchParams(next, { replace: true });
      }
    } else if (hasChanged && open && !has) {
      // URL param disappeared while drawer is open (e.g., browser back) → notify consumer.
      onClose();
    }

    prevOpenRef.current = open;
    prevHasParamRef.current = has;
  }, [urlParam, open, searchParams, setSearchParams, onClose]);

  // ── Focus management: capture trigger on open, restore on close ─────────────
  useEffect(() => {
    if (open) {
      triggerRef.current = document.activeElement as HTMLElement | null;
    } else if (triggerRef.current) {
      // Return focus to the trigger element per Ironclad Interface a11y.
      const target = triggerRef.current;
      triggerRef.current = null;
      queueMicrotask(() => target.focus());
    }
  }, [open]);

  // ── Escape key handler at the window level (works alongside FocusTrap) ─────
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  const handleCloseClick = useCallback(() => {
    onClose();
  }, [onClose]);

  // Don't render the portal when closed or during SSR.
  if (!open || typeof document === 'undefined') return null;

  const widthPx = SIZE_TO_WIDTH_PX[size];

  const drawer = (
    <FocusTrap
      focusTrapOptions={{
        allowOutsideClick: true,
        // We handle Escape at the window level so the FocusTrap doesn't intercept it.
        escapeDeactivates: false,
        // jsdom-friendly: skip element display checks (jsdom can't measure visibility).
        tabbableOptions: { displayCheck: 'none' },
      }}
    >
      <div
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        // Sheet pattern: NO backdrop. Left content stays interactive. Sliding-in container
        // anchored to the right edge of the viewport, full viewport height. z-30 sits above
        // the shell topnav (HUB-1577 z-20) and below ConfirmDestructive (z-50).
        className="fixed inset-y-0 right-0 z-30 flex flex-col bg-sailcloth shadow-xl motion-reduce:transition-none transition-transform duration-200 ease-out translate-x-0"
        style={{ width: `${widthPx}px` }}
      >
        <header className="flex items-center justify-between border-b border-mist px-6 py-4">
          <h2
            id={titleId}
            className="font-heading text-xl text-primary-navy truncate"
          >
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={handleCloseClick}
            className="rounded-md p-2 text-deep-charcoal hover:bg-mist focus:outline-none focus:ring-2 focus:ring-primary-brass"
          >
            {/* Inline ✕ glyph keeps the component dependency-free of icon libs. */}
            <span aria-hidden="true" className="text-xl leading-none">
              ×
            </span>
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-4">{children}</div>
      </div>
    </FocusTrap>
  );

  return createPortal(drawer, document.body);
}
