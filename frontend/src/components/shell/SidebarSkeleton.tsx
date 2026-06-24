// Authorized by HUB-1577 — Sidebar skeleton during session hydration (S8 AC#5).
// Matches final sidebar dimensions to prevent CLS; shimmer respects prefers-reduced-motion.
export function SidebarSkeleton(): React.ReactElement {
  return (
    <div
      aria-hidden="true"
      data-testid="sidebar-skeleton"
      className="w-16 xl:w-60 bg-primary-navy/95 motion-reduce:animate-none animate-pulse"
    >
      <ul className="py-2">
        {[0, 1, 2].map((i) => (
          <li key={i} className="px-4 py-3 mx-2 my-0.5 rounded-md bg-sailcloth/10" />
        ))}
      </ul>
    </div>
  );
}

export function TopNavSkeleton(): React.ReactElement {
  return (
    <div
      aria-hidden="true"
      data-testid="top-nav-skeleton"
      className="h-14 bg-primary-navy/95 motion-reduce:animate-none animate-pulse shadow-md"
    />
  );
}
