// Authorized by HUB-1569 — App root; BrowserRouter + Suspense + lazy /console/login
// Authorized by HUB-1576 — login route + post-login redirect target
// Authorized by HUB-1577 — ConsoleShell layout + DashboardStub at /console/dashboard
//   (replaces HUB-1576 temporary placeholder per D-HUB-SCOPE-027)
// Authorized by HUB-1578 — GuardedRoute wraps every /console/* route (RBAC + toast emit);
//   AuditStub + SettingsStub placeholder routes (super_admin only) — supersession owned
//   by HUB-1558 + HUB-1564 per D-HUB-SCOPE-027 pattern
// Authorized by HUB-1579 — drains pendingRevokes queue on mount (retry-on-reconnect for
//   logout BE calls that failed during prior sessions); see D-HUB-SCOPE-050
// Authorized by HUB-1581 — bootstrap hydrate-from-refresh on App mount (closes HUB-1572 R1
//   wiring gap: without this, sessionStore.isHydrating stays true forever and ConsoleShell
//   never advances past the skeleton; surfaced by S12 e2e tests)
// Authorized by HUB-1612 (E-FE-12 S2) — /console/audit now routes to Audit (real scaffold),
//   superseding HUB-1578's AuditStub per D-HUB-SCOPE-027. requiredRole broadened from
//   super_admin to product_admin per HUB-1612 AC#1: both roles may access the audit
//   explorer (role hierarchy keeps super_admin allowed; product_admin newly granted; the
//   per-product RBAC scope filter belongs to HUB-1618 S8 on the BE side).
// Authorized by HUB-1603 (E-FE-3 S3) — /console/products route registered. Both
//   product_admin and super_admin may access (RBAC scope-specific filtering is BE-side
//   per HUB-1609 S9 + HUB-1700 server enforcement).
// Authorized by HUB-1604 (E-FE-3 S4) — /console/products/:productId detail scaffold
//   route added. Same guard as the list view.
// Authorized by HUB-1622 (E-FE-8 S3) — /console/compliance route registered. Both
//   product_admin and super_admin may access (RBAC scope-specific filtering is BE
//   per HUB-1628 S9).
// Authorized by HUB-1644 (E-FE-2 S1) — /console/dashboard now routes to the real
//   Dashboard shell (three named widget regions: portfolioSummary, productGrid,
//   sidebar). Supersedes the HUB-1577 / HUB-1694 DashboardStub per HUB-1546 §7
//   step 2. Same product_admin guard.
// Authorized by HUB-1654 (E-FE-5 S4) — /console/products/:productId/pricing
//   route registered (Pricing Model Editor). super_admin only per FR-002 (PUT
//   route BE enforcement); guard is super_admin.
// Authorized by HUB-1655 (E-FE-5 S5) — /console/products/:productId/pricing/plans
//   route registered (PlansManager: list + New + Edit + Archive). super_admin
//   only per Epic AC #2 (POST /api/v1/admin/plans + PUT + DELETE are mutations
//   with immediate Stripe impact).
import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ConsoleShell } from './components/shell/ConsoleShell';
import { GuardedRoute } from './components/GuardedRoute';
import { Toaster } from './components/Toaster';
import { apiClient } from './lib/api';
import { drainPendingRevokes } from './lib/pendingRevokes';
import { useSessionStore } from './stores/sessionStore';

const Login = lazy(() => import('./routes/Login'));
const Dashboard = lazy(() => import('./routes/Dashboard'));
const Audit = lazy(() => import('./routes/Audit'));
const Products = lazy(() => import('./routes/Products'));
const ProductDetail = lazy(() => import('./routes/ProductDetail'));
const PricingModelEditor = lazy(
  () => import('./routes/productDetail/PricingModelEditor'),
);
const PlansManager = lazy(
  () => import('./routes/productDetail/PlansManager'),
);
const Compliance = lazy(() => import('./routes/Compliance'));
const ComplianceDetail = lazy(() => import('./routes/ComplianceDetail'));
const SdkVersions = lazy(() => import('./routes/SdkVersions'));
const PlanAdvisor = lazy(() => import('./routes/PlanAdvisor'));
const NewRecommendationFlow = lazy(
  () => import('./routes/planAdvisor/NewRecommendationFlow'),
);
const RecommendationResultView = lazy(
  () => import('./routes/planAdvisor/RecommendationResultView'),
);
const SettingsStub = lazy(() => import('./routes/SettingsStub'));

export function App() {
  useEffect(() => {
    // HUB-1579: drain any queued logout revocations from prior sessions / failed BE calls.
    // Best-effort; remaining entries stay queued for the next bootstrap.
    void drainPendingRevokes((refreshToken) =>
      apiClient.post('/api/v1/admin/auth/logout', { refreshToken }),
    );
    // HUB-1581: bootstrap hydrate-from-refresh per HUB-1572 R1 contract. Either resolves
    // with a fresh session (authenticated user reload) or rejects (no refresh cookie /
    // expired) — both paths clear isHydrating so ConsoleShell can render past the skeleton.
    void useSessionStore.getState().hydrateFromRefresh(() => apiClient.refresh());
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
                  <Dashboard />
                </GuardedRoute>
              }
            />
            <Route
              path="/console/audit"
              element={
                <GuardedRoute requiredRole="product_admin">
                  <Audit />
                </GuardedRoute>
              }
            />
            <Route
              path="/console/products"
              element={
                <GuardedRoute requiredRole="product_admin">
                  <Products />
                </GuardedRoute>
              }
            />
            <Route
              path="/console/products/:productId"
              element={
                <GuardedRoute requiredRole="product_admin">
                  <ProductDetail />
                </GuardedRoute>
              }
            />
            <Route
              path="/console/products/:productId/pricing"
              element={
                <GuardedRoute requiredRole="super_admin">
                  <PricingModelEditor />
                </GuardedRoute>
              }
            />
            <Route
              path="/console/products/:productId/pricing/plans"
              element={
                <GuardedRoute requiredRole="super_admin">
                  <PlansManager />
                </GuardedRoute>
              }
            />
            <Route
              path="/console/compliance"
              element={
                <GuardedRoute requiredRole="product_admin">
                  <Compliance />
                </GuardedRoute>
              }
            />
            <Route
              path="/console/compliance/:productId"
              element={
                <GuardedRoute requiredRole="product_admin">
                  <ComplianceDetail />
                </GuardedRoute>
              }
            />
            <Route
              path="/console/sdk-versions"
              element={
                <GuardedRoute requiredRole="super_admin">
                  <SdkVersions />
                </GuardedRoute>
              }
            />
            <Route
              path="/console/plan-advisor"
              element={
                <GuardedRoute requiredRole="product_admin">
                  <PlanAdvisor />
                </GuardedRoute>
              }
            />
            <Route
              path="/console/plan-advisor/new"
              element={
                <GuardedRoute requiredRole="product_admin">
                  <NewRecommendationFlow />
                </GuardedRoute>
              }
            />
            <Route
              path="/console/plan-advisor/:runId"
              element={
                <GuardedRoute requiredRole="product_admin">
                  <RecommendationResultView />
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
