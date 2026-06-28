// Authorized by HUB-1602 (E-FE-3 S2) — TabbedDetailView reusable component. Cross-Epic
// primitive: tab strip + URL deep-link + per-tab error boundary + accessible tabs
// pattern. Consumers (HUB-1604 product detail, downstream HUB-1564/1567) inherit a
// consistent tabbed-detail UX without re-implementing the ARIA semantics or the
// keyboard nav.
//
// URL deep-link: active tab id is mirrored to the URL via setSearchParams(replace:true).
// Preserves other URL params (audit's ?eventId, etc.). Browser back/forward
// "just works" because the active tab is derived from URL state on every render.
//
// Per-tab error boundary: a TabErrorBoundary class component wraps each rendered tab.
// We key the boundary by tab.id so switching to a non-failing tab resets the error
// state — a single boundary instance whose children change wouldn't (React keeps
// hasError=true). One throwing tab does NOT poison the other tabs.
//
// Lazy render: only the active tab's content is mounted. Inactive tab content is
// removed from the DOM entirely. Consumers needing persistent state across tab
// switches must own their state above the tab boundary (Zustand store, etc.).
import {
  Component,
  useCallback,
  useMemo,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useSearchParams } from 'react-router-dom';

export interface TabDef {
  id: string;
  label: string;
  badge?: ReactNode;
  content: ReactNode | (() => ReactNode);
  /** Optional per-tab fallback. Defaults to DEFAULT_ERROR_FALLBACK below. */
  errorFallback?: ReactNode;
}

export interface TabbedDetailViewProps {
  tabs: TabDef[];
  /** Tab to activate when the URL param is absent or unrecognized. Falls back to tabs[0]. */
  defaultTab?: string;
  /** URL query-string key the active tab id is mirrored to. Default 'tab'. */
  urlParam?: string;
  /** Optional aria-label for the tablist (for screens with multiple tablists). */
  ariaLabel?: string;
}

interface TabErrorBoundaryProps {
  fallback: ReactNode;
  children: ReactNode;
}

interface TabErrorBoundaryState {
  hasError: boolean;
}

class TabErrorBoundary extends Component<
  TabErrorBoundaryProps,
  TabErrorBoundaryState
> {
  state: TabErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): TabErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error): void {
    console.error('TabbedDetailView: tab content threw —', error);
  }

  render(): ReactNode {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

const DEFAULT_ERROR_FALLBACK: ReactNode = (
  <div role="alert" className="p-4 text-sm font-body text-ironwake">
    Failed to load this tab. Try refreshing or contact support.
  </div>
);

export function TabbedDetailView({
  tabs,
  defaultTab,
  urlParam = 'tab',
  ariaLabel,
}: TabbedDetailViewProps): React.ReactElement {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabIds = useMemo(() => new Set(tabs.map((t) => t.id)), [tabs]);
  const urlTab = searchParams.get(urlParam);

  const activeId = useMemo(() => {
    if (urlTab && tabIds.has(urlTab)) return urlTab;
    if (defaultTab && tabIds.has(defaultTab)) return defaultTab;
    return tabs[0]?.id ?? '';
  }, [urlTab, defaultTab, tabIds, tabs]);

  const tabButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const changeTab = useCallback(
    (id: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set(urlParam, id);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams, urlParam],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
      let nextIndex = index;
      switch (event.key) {
        case 'ArrowRight':
          nextIndex = (index + 1) % tabs.length;
          break;
        case 'ArrowLeft':
          nextIndex = (index - 1 + tabs.length) % tabs.length;
          break;
        case 'Home':
          nextIndex = 0;
          break;
        case 'End':
          nextIndex = tabs.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      const nextTab = tabs[nextIndex];
      if (!nextTab) return;
      changeTab(nextTab.id);
      // Focus moves with selection (automatic activation pattern per WAI-ARIA).
      tabButtonRefs.current[nextTab.id]?.focus();
    },
    [tabs, changeTab],
  );

  if (tabs.length === 0) {
    return (
      <div className="p-4 text-sm font-body text-deep-charcoal/70">
        No tabs to display.
      </div>
    );
  }

  const activeTab =
    tabs.find((t) => t.id === activeId) ?? tabs[0];
  // tabs.length > 0 above guarantees activeTab is defined here.
  if (!activeTab) return <div />;
  const activeContent =
    typeof activeTab.content === 'function'
      ? activeTab.content()
      : activeTab.content;

  return (
    <div className="flex flex-col">
      <div
        role="tablist"
        aria-orientation="horizontal"
        aria-label={ariaLabel}
        className="flex border-b border-deep-charcoal/15"
      >
        {tabs.map((tab, index) => {
          const isActive = tab.id === activeId;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                tabButtonRefs.current[tab.id] = el;
              }}
              type="button"
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={isActive}
              aria-controls={`tabpanel-${tab.id}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => changeTab(tab.id)}
              onKeyDown={(e) => handleKeyDown(e, index)}
              data-testid={`tab-${tab.id}`}
              className={
                isActive
                  ? 'inline-flex items-center gap-2 border-b-2 border-accent-brass bg-sailcloth px-4 py-2 text-sm font-body text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass'
                  : 'inline-flex items-center gap-2 border-b-2 border-transparent px-4 py-2 text-sm font-body text-deep-charcoal/70 hover:text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass'
              }
            >
              <span>{tab.label}</span>
              {tab.badge !== undefined && tab.badge !== null && (
                <span data-testid={`tab-badge-${tab.id}`}>{tab.badge}</span>
              )}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`tabpanel-${activeTab.id}`}
        aria-labelledby={`tab-${activeTab.id}`}
        tabIndex={0}
        data-testid={`tabpanel-${activeTab.id}`}
        className="focus:outline-none"
      >
        {/* keyed by tab.id so the boundary resets on tab switch — a single instance
            whose children change wouldn't, leaving hasError=true sticky. */}
        <TabErrorBoundary
          key={activeTab.id}
          fallback={activeTab.errorFallback ?? DEFAULT_ERROR_FALLBACK}
        >
          {activeContent}
        </TabErrorBoundary>
      </div>
    </div>
  );
}
