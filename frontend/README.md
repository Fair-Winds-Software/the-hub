# HUB Operator Console — Frontend

Vite + React + TypeScript SPA served by the HUB Fastify backend in production
(see `src/plugins/spaShell.ts` for the production-mode static serve gate).

## Scripts

| Script | What |
|---|---|
| `npm run dev` | Vite dev server on :5173, proxies `/api/v1` to backend :3000 |
| `npm run build` | Production build → `dist/` |
| `npm run preview` | Serve built `dist/` on :4173 (used by e2e + lighthouse jobs) |
| `npm run test` | Vitest unit tests (component + lib) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint over `src/` |
| `npm run e2e` | Playwright + @axe-core/playwright e2e + a11y scan |
| `npm run e2e:install` | First-time install of Playwright Chromium browser |
| `npm run lighthouse` | Lighthouse CI: CWV + a11y gate on `/console/login` |

## A11y + CWV gate (HUB-1581)

Two CI jobs enforce the NFR baseline; see `.github/workflows/a11y-perf.yml`.

**Playwright + @axe-core/playwright (`npm run e2e`)** — scans both
`/console/login` and `/console/dashboard` for axe-core 0 violations against
WCAG 2.1 AA tags, plus keyboard navigation scenarios. Tests mock the BE auth
endpoints via Playwright `page.route()` so they run without a real backend.

**Lighthouse CI (`npm run lighthouse`)** — runs 3 desktop audits against
`/console/login` and gates:

- LCP ≤ 2.5 s
- CLS ≤ 0.1
- TBT ≤ 200 ms
- Accessibility score ≥ 0.95

### Why is `/console/dashboard` excluded from Lighthouse?

The Zustand session store (`src/stores/sessionStore.ts`) is in-memory
per-page. Lighthouse opens its measurement page in its own JS context with an
empty store, so a pre-audit `puppeteerScript` that drives the login form on a
different page cannot transfer the session. Without a real backend in CI, any
dashboard measurement would actually measure the auth-guard redirect to
`/console/login`. Decision: defer dashboard CWV to HUB-1562 (E-FE-2), which
both lands real dashboard content AND introduces a CI auth setup it can rely
on. Documented as **D-HUB-SCOPE-051** in the Decision Log (Confluence
494698498).

axe-core still covers `/console/dashboard` because Playwright route mocking
DOES work on the same page that drives the login form.

### Extending the scan list when adding new routes

When a future Epic adds a new `/console/*` route:

1. **axe-core (`__tests__/e2e/a11y.spec.ts`)** — add a new `test()` under
   `HUB-1581 AC#1` that navigates to the new route (using the
   `mockAuthenticatedFlow()` helper for authenticated routes) and runs an
   `AxeBuilder` scan with the WCAG 2.1 AA tag set.
2. **Lighthouse (`lighthouserc.cjs`)** — for unauthenticated routes, add the
   URL to `ci.collect.url`. For authenticated routes, defer to a future story
   that lands the CI auth setup (see D-HUB-SCOPE-051).
3. **Keyboard nav** — if the route adds new interactive elements, add a
   keyboard-nav `test()` under `HUB-1581 AC#3` or `AC#4` covering Tab order.

Re-run `npm run e2e && npm run lighthouse` locally to verify gates still pass
before opening the PR.

## Pricing & Billing NFR gate (HUB-1659)

The a11y + RBAC gate for the five HUB-1563 pricing routes
(`/console/products/:productId/pricing`, `/pricing/plans`,
`/pricing/addons`, `/pricing/exceptions`, `/pricing/freeze`) is enforced
via `src/routes/productDetail/__tests__/pricing.nfr.test.tsx`: axe
zero-violations across each of the S4..S8 surfaces + static-source
verification that every pricing route sits behind
`GuardedRoute(super_admin)` in App.tsx. All currency + date rendering
routes through `src/routes/productDetail/pricing-formatters.ts` so the
FR-021 "raw cents never visible" invariant holds across the whole Epic.
Lighthouse CWV measurement of the pricing routes defers to Stage 4 per
D-HUB-SCOPE-051.

## Dashboard NFR gate (HUB-1650)

The a11y + CWV gate for `/console/dashboard` is enforced via
`src/routes/__tests__/Dashboard.nfr.test.tsx` (synthetic axe scan on all
three widget regions + render-perf assertion + widget-isolation
invariant that proves a single fetch failure does NOT blank the
dashboard). All widgets are wrapped by
`src/routes/dashboard/WidgetErrorBoundary` so a runtime throw in one
widget cannot cascade. Currency + relative-time formatting live in a
single `src/routes/dashboard/dashboard-formatters.ts` module consumed
by every widget. Lighthouse CWV measurement of `/console/dashboard`
defers to Stage 4 per D-HUB-SCOPE-051 (same in-memory session-store
constraint as every other post-auth route).

## Plan advisor NFR gate (HUB-1643)

The a11y + CWV gate for `/console/plan-advisor`, `/console/plan-advisor/new`,
and `/console/plan-advisor/:runId` is enforced via
`src/routes/planAdvisor/__tests__/PlanAdvisor.nfr.test.tsx` (synthetic axe
scan + render-perf assertion + advisory-warning prominence + outcome-button
semantic-ARIA check). Lighthouse CWV measurement of the plan-advisor routes
defers to Stage 4 alongside every other post-auth route per
D-HUB-SCOPE-051 (same in-memory session-store constraint as
`/console/dashboard`).

## RBAC scope enforcement (HUB-1642)

Server-side RBAC is authoritative for the operator console. The FE only
mirrors what the server returns:

- `/api/v1/admin/portfolio/products` returns only in-scope products for
  `product_admin`; the plan-advisor list-view product filter (S2) and the
  new-recommendation product picker (S3) simply render whatever comes back.
- `super_admin` sees all products via the same endpoint.
- **plan-advisor endpoint RBAC enforcement is per-productId; out-of-scope
  productId → 403.** The FE surfaces the 403 as:
  - Result view (`/console/plan-advisor/:runId`): `<AccessDeniedPage>` with
    a `Back to advisor list` link (HUB-1640).
  - New-recommendation POST `/run`: inline scope-denial banner
    (`new-recommendation-scope-denied`) so the picker stays visible and the
    operator can pick a different in-scope product (HUB-1642).

Client-side guards (`useRBACGuard`, sidebar filtering) are UX-layer only —
they hide unreachable nav and redirect URL-hack attempts, but the server
remains the security boundary and every advisor endpoint enforces its own
per-productId scope check.
