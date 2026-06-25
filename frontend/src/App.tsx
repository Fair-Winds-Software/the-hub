// Authorized by HUB-1569 — App root; BrowserRouter + Suspense + lazy /console/login
// Authorized by HUB-1576 — login route + post-login redirect target
// Authorized by HUB-1577 — ConsoleShell layout + DashboardStub at /console/dashboard
//   (replaces HUB-1576 temporary placeholder per D-HUB-SCOPE-027)
// Authorized by HUB-1578 — GuardedRoute wraps every /console/* route (RBAC + toast emit);
//   AuditStub + SettingsStub placeholder routes (super_admin only) — supersession owned
//   by HUB-1558 + HUB-1564 per D-HUB-SCOPE-027 pattern
// Authorized by HUB-1579 — drains pendingRevokes queue on mount (retry-on-reconnect for
//   logout BE calls that failed during prior sessions); see D-HUB-SCOPE-050
import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ConsoleShell } from './components/shell/ConsoleShell';
import { GuardedRoute } from './components/GuardedRoute';
import { Toaster } from './components/Toaster';
import { apiClient } from './lib/api';
import { drainPendingRevokes } from './lib/pendingRevokes';

const Login = lazy(() => import('./routes/Login'));
const DashboardStub = lazy(() => import('./routes/DashboardStub'));
const AuditStub = lazy(() => import('./routes/AuditStub'));
const SettingsStub = lazy(() => import('./routes/SettingsStub'));

export function App() {
  useEffect(() => {
    // HUB-1579: drain any queued logout revocations from prior sessions / failed BE calls.
    // Best-effort; remaining entries stay queued for the next bootstrap.
    void drainPendingRevokes((refreshToken) =>
      apiClient.post('/api/v1/admin/auth/logout', { refreshToken }),
    );
  }, []);

  return (
    <BrowserRouter>
      <Suspense fallback={<div>Loading…</div>}>
        <Routes>
          <Route path="/console/login" element={<Login />} />
          <Route element={<ConsoleShell />}>
            <Route
              path="/console/dashboard"
              element={
                <GuardedRoute requiredRole="product_admin">
                  <DashboardStub />
                </GuardedRoute>
              }
            />
            <Route
              path="/console/audit"
              element={
                <GuardedRoute requiredRole="super_admin">
                  <AuditStub />
                </GuardedRoute>
              }
            />
            <Route
              path="/console/settings"
              element={
                <GuardedRoute requiredRole="super_admin">
                  <SettingsStub />
                </GuardedRoute>
              }
            />
          </Route>
          <Route path="*" element={<Navigate to="/console/login" replace />} />
        </Routes>
        {/* HUB-1578: Toaster mounted at App root so toasts persist across the
            login/shell route boundary (e.g., unauthenticated guard denial → redirect
            to /console/login → toast must remain visible). */}
        <Toaster />
      </Suspense>
    </BrowserRouter>
  );
}
