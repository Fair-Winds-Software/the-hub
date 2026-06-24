// Authorized by HUB-1577 — Console Shell layout (S8 of HUB-1555).
import { Outlet } from 'react-router-dom';
import { useIsHydrating } from '../../stores/sessionStore';
import { TopNav } from './TopNav';
import { Sidebar } from './Sidebar';
import { SidebarSkeleton, TopNavSkeleton } from './SidebarSkeleton';
import { ConsoleShellErrorBoundary } from './ConsoleShellErrorBoundary';

export function ConsoleShell(): React.ReactElement {
  const isHydrating = useIsHydrating();

  if (isHydrating) {
    return (
      <div className="min-h-screen flex flex-col bg-sailcloth">
        <TopNavSkeleton />
        <div className="flex flex-1">
          <SidebarSkeleton />
          <main
            id="main-content"
            data-testid="main-content-skeleton"
            className="flex-1 p-6"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-sailcloth">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:bg-sailcloth focus:text-primary-navy focus:px-3 focus:py-2 focus:rounded-md focus:shadow-md"
      >
        Skip to content
      </a>
      <TopNav />
      <div className="flex flex-1">
        <Sidebar />
        <main id="main-content" className="flex-1 p-6 overflow-auto">
          <ConsoleShellErrorBoundary>
            <Outlet />
          </ConsoleShellErrorBoundary>
        </main>
      </div>
    </div>
  );
}
