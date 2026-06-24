// Authorized by HUB-1569 — App root; BrowserRouter + Suspense + lazy /console/login
// Authorized by HUB-1576 — login route + post-login redirect target
// Authorized by HUB-1577 — ConsoleShell layout + DashboardStub at /console/dashboard
//   (replaces HUB-1576 temporary placeholder per D-HUB-SCOPE-027) + RBACRoute guard
import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ConsoleShell } from './components/shell/ConsoleShell';
import { RBACRoute } from './components/RBACRoute';

const Login = lazy(() => import('./routes/Login'));
const DashboardStub = lazy(() => import('./routes/DashboardStub'));

export function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<div>Loading…</div>}>
        <Routes>
          <Route path="/console/login" element={<Login />} />
          <Route element={<ConsoleShell />}>
            <Route
              path="/console/dashboard"
              element={
                <RBACRoute requiredRole="product_admin">
                  <DashboardStub />
                </RBACRoute>
              }
            />
          </Route>
          <Route path="*" element={<Navigate to="/console/login" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
