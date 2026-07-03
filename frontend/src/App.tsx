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
// Authorized by HUB-1656 (E-FE-5 S6) — /console/products/:productId/pricing/addons
//   route registered (AddOnsManager). Same super_admin guard.
// Authorized by HUB-1657 (E-FE-5 S7) — /console/products/:productId/pricing/exceptions
//   route registered (PricingExceptionsManager: Discounts + Overrides tabs).
//   Same super_admin guard.
// Authorized by HUB-1658 (E-FE-5 S8) — /console/products/:productId/pricing/freeze
//   route registered (BillingFreezeControls). Same super_admin guard.
// Authorized by HUB-1662 (E-FE-6 S3) — /console/settings shell now nests five
//   sub-routes (operators, hub, notifications, escalation, hooks). Each is
//   independently deep-linkable and super_admin-guarded; default redirect
//   /console/settings → /console/settings/operators. Un-merged sub-routes
//   render SettingsPlaceholder pending S4..S8. Supersedes HUB-1578 SettingsStub.
// Authorized by HUB-1663 (E-FE-6 S4) — operators sub-route replaced by real
//   OperatorsManager (list + New + Edit + Deactivate + last-super_admin
//   FE-side guard). Placeholder for /operators removed from the sub-route.
// Authorized by HUB-1664 (E-FE-6 S5) — /hub sub-route replaced by real
//   HubSettingsManager (catalog-driven editor + JSON fallback). Placeholder
//   for /hub removed.
// Authorized by HUB-1665 (E-FE-6 S6) — /notifications sub-route replaced by
//   real NotificationsManager (product picker + channel CRUD + soft-archive).
//   Placeholder for /notifications removed.
// Authorized by HUB-1666 (E-FE-6 S7) — /escalation sub-route replaced by real
//   EscalationManager (product picker + per-alert-type tier list + New/Archive
//   flows within the BE 2-tier cap). Placeholder for /escalation removed.
// Authorized by HUB-1667 (E-FE-6 S8) — /hooks sub-route replaced by real
//   WorkflowHooksManager (tenant picker + hook list + expandable execution
//   history + New/Archive). All 5 settings sub-routes are now real; the
//   SettingsPlaceholder import is removed from App.tsx (still used by the
//   Settings shell test file).
// Authorized by HUB-1675 (E-FE-7 S2) — /console/system-health portfolio grid
//   route registered. product_admin + super_admin may access; scoping is
//   server-authoritative via HUB-1674.
// Authorized by HUB-1676 (E-FE-7 S3) — /console/system-health/:productId
//   drill-in shell with 4 nested tab sub-routes (liveness / errors / queues
//   / webhooks). Each sub-route is independently deep-linkable and lazy-
//   mounted via React Router's <Outlet>. Un-shipped tab content renders
//   SystemHealthTabPlaceholder pending HUB-1677 (S4) + HUB-1678 (S5).
// Authorized by HUB-1677 (E-FE-7 S4) — /liveness + /errors sub-routes
//   replaced by real tab components (badge + re-probe / audit-log row
//   drawer). Placeholders for those two tabs removed.
// Authorized by HUB-1678 (E-FE-7 S5) — /queues + /webhooks sub-routes
//   replaced by real tab components (BullMQ depth + Stripe webhook
//   metric tiles). Placeholders for those two tabs removed; the
//   SystemHealthTabPlaceholder import is no longer needed at App.tsx.
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
const AddOnsManager = lazy(
  () => import('./routes/productDetail/AddOnsManager'),
);
const PricingExceptionsManager = lazy(
  () => import('./routes/productDetail/PricingExceptionsManager'),
);
const BillingFreezeControls = lazy(
  () => import('./routes/productDetail/BillingFreezeControls'),
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
const Settings = lazy(() => import('./routes/Settings'));
const OperatorsManager = lazy(
  () => import('./routes/settings/OperatorsManager'),
);
const HubSettingsManager = lazy(
  () => import('./routes/settings/HubSettingsManager'),
);
const NotificationsManager = lazy(
  () => import('./routes/settings/NotificationsManager'),
);
const EscalationManager = lazy(
  () => import('./routes/settings/EscalationManager'),
);
const WorkflowHooksManager = lazy(
  () => import('./routes/settings/WorkflowHooksManager'),
);
const SystemHealth = lazy(() => import('./routes/SystemHealth'));
const SystemHealthDetail = lazy(() => import('./routes/SystemHealthDetail'));
const SystemHealthLivenessTab = lazy(
  () => import('./routes/systemHealth/SystemHealthLivenessTab'),
);
const SystemHealthErrorsTab = lazy(
  () => import('./routes/systemHealth/SystemHealthErrorsTab'),
);
const SystemHealthQueuesTab = lazy(
  () => import('./routes/systemHealth/SystemHealthQueuesTab'),
);
const SystemHealthWebhooksTab = lazy(
  () => import('./routes/systemHealth/SystemHealthWebhooksTab'),
);
const CustomerHealth = lazy(() => import('./routes/CustomerHealth'));
const CustomerHealthDetail = lazy(
  () => import('./routes/CustomerHealthDetail'),
);
const PricingScenario = lazy(() => import('./routes/PricingScenario'));

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
              path="/console/products/:productId/pricing/addons"
              element={
                <GuardedRoute requiredRole="super_admin">
                  <AddOnsManager />
                </GuardedRoute>
              }
            />
            <Route
              path="/console/products/:productId/pricing/exceptions"
              element={
                <GuardedRoute requiredRole="super_admin">
                  <PricingExceptionsManager />
                </GuardedRoute>
              }
            />
            <Route
              path="/console/products/:productId/pricing/freeze"
              element={
                <GuardedRoute requiredRole="super_admin">
                  <BillingFreezeControls />
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
              path="/console/system-health"
              element={
                <GuardedRoute requiredRole="product_admin">
                  <SystemHealth />
                </GuardedRoute>
              }
            />
            <Route
              path="/console/system-health/:productId"
              element={
                <GuardedRoute requiredRole="product_admin">
                  <SystemHealthDetail />
                </GuardedRoute>
              }
            >
              <Route index element={<Navigate to="liveness" replace />} />
              <Route path="liveness" element={<SystemHealthLivenessTab />} />
              <Route path="errors" element={<SystemHealthErrorsTab />} />
              <Route path="queues" element={<SystemHealthQueuesTab />} />
              <Route path="webhooks" element={<SystemHealthWebhooksTab />} />
            </Route>
            {/* HUB-1681 (E-FE-9 S2) — /console/customer-health list */}
            <Route
              path="/console/customer-health"
              element={
                <GuardedRoute requiredRole="product_admin">
                  <CustomerHealth />
                </GuardedRoute>
              }
            />
            {/* HUB-1683 (E-FE-9 S4) — drill-in shell */}
            <Route
              path="/console/customer-health/:tenantId"
              element={
                <GuardedRoute requiredRole="product_admin">
                  <CustomerHealthDetail />
                </GuardedRoute>
              }
            />
            {/* HUB-1669 (E-FE-11 S1) — Pricing Scenario Simulator */}
            <Route
              path="/console/pricing-scenario"
              element={
                <GuardedRoute requiredRole="product_admin">
                  <PricingScenario />
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
                  <Settings />
                </GuardedRoute>
              }
            >
              <Route
                index
                element={<Navigate to="/console/settings/operators" replace />}
              />
              <Route path="operators" element={<OperatorsManager />} />
              <Route path="hub" element={<HubSettingsManager />} />
              <Route path="notifications" element={<NotificationsManager />} />
              <Route path="escalation" element={<EscalationManager />} />
              <Route path="hooks" element={<WorkflowHooksManager />} />
            </Route>
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
