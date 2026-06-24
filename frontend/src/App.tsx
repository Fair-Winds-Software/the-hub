// Authorized by HUB-1569 — App root; BrowserRouter + Suspense + lazy /console/login stub
// Authorized by HUB-1576 — adds /console/dashboard placeholder route (HUB-1577 will replace
// with DashboardStub + shell) so post-login navigation has a landing target
import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

const Login = lazy(() => import('./routes/Login'));

// TODO HUB-1577: replace with DashboardStub wrapped in app shell + RBACRoute.
function DashboardPlaceholder(): React.ReactElement {
  return (
    <main className="min-h-screen bg-sailcloth p-8">
      <h1 className="font-heading text-2xl text-primary-navy">Console Dashboard</h1>
      <p className="font-body text-deep-charcoal mt-2">
        Placeholder — shell + real dashboard delivered in HUB-1577 / E-FE-2.
      </p>
    </main>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<div>Loading…</div>}>
        <Routes>
          <Route path="/console/login" element={<Login />} />
          <Route path="/console/dashboard" element={<DashboardPlaceholder />} />
          <Route path="*" element={<Navigate to="/console/login" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
