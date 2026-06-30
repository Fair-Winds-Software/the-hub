<!-- Authorized by HUB-1575 — canonical component patterns for the HUB Operator Console SPA -->

# HUB Operator Console — Shared Components

This module hosts reusable UI primitives consumed across every downstream FE Epic in the HUB-1546 v0.1 wave. Each component below is authored once, tested once, and inherited everywhere — no Epic re-implements these patterns.

## `<ConfirmDestructive>` — Two-step destructive-action confirmation

Authoritative source: [`ConfirmDestructive.tsx`](./ConfirmDestructive.tsx) (authored by HUB-1575).

**Use when:** any operator action causes irreversible side effects, customer-visible state changes, or revenue impact — e.g.:

- Dashboard "Freeze billing" (HUB-1562 / E-FE-2)
- Settings destructive actions: deactivate operator, rotate signing key, archive product (HUB-1564 / E-FE-6)
- Failed Payment Tracker manual override of an invoice (HUB-1568 / E-FE-13)
- Compliance attestation reset (HUB-1559 / E-FE-8)
- Customer Health "mark churned" overrides (HUB-1567 / E-FE-9, where applicable)

**Required for all destructive actions in HUB-1546 v0.1.** Re-implementing the pattern in a downstream Epic is an automatic R1 BLOCK.

### Minimum usage

```tsx
import { ConfirmDestructive } from '../components/ConfirmDestructive';

<ConfirmDestructive
  title="Freeze billing for Synapz?"
  body="Active subscriptions pause. Invoices stop generating until you unfreeze."
  onConfirm={async () => {
    await apiClient.post('/api/v1/admin/billing/freeze', { productId });
  }}
  trigger={(open) => (
    <button type="button" onClick={open} className="bg-ironwake text-sailcloth ...">
      Freeze billing
    </button>
  )}
/>
```

### Use with `requirePhrase` for high-blast-radius actions

When the consequence is severe enough that a misclick is unacceptable (deleting an operator, archiving a product), require the operator to type an exact phrase before the confirm button activates:

```tsx
<ConfirmDestructive
  title="Archive Synapz product?"
  body="All active leases will be revoked. Customers will see access errors immediately."
  requirePhrase="ARCHIVE-Synapz"
  onConfirm={async () => { await apiClient.delete(`/api/v1/admin/products/${productId}`); }}
  trigger={(open) => <button onClick={open}>Archive product</button>}
/>
```

### Behavior contract

| State | Behavior |
|---|---|
| Cancel button | Closes modal; resets typed phrase + error; returns focus to trigger |
| Backdrop click | Closes modal **only if** no phrase typed AND not pending |
| Escape key | Closes modal **only if** not pending |
| Confirm button | Disabled until `requirePhrase` (if set) matches exactly; while pending shows spinner + "Working…" |
| `onConfirm` resolves | Modal closes; internal state reset; focus returns to trigger |
| `onConfirm` rejects | Error message renders inline (role="alert"); modal stays open for retry; pending cleared |

### A11y guarantees

- `role="alertdialog"`, `aria-modal="true"`, `aria-labelledby`, `aria-describedby` — full ARIA dialog contract
- Focus trapped inside the modal via `focus-trap-react`
- Focus returns to the trigger element on close
- Respects `prefers-reduced-motion: reduce` (skips fade animations)
- WCAG 2.1 AA color contrast verified by axe-core integration test

### What `<ConfirmDestructive>` does NOT do

- It does NOT perform the destructive action — the consumer's `onConfirm` callback owns the side effect (API call, toast, audit log).
- It does NOT show a toast on success — the consumer wires that (toast system is HUB-1577).
- It does NOT capture an `audit_log` entry — the BE endpoint the consumer calls is responsible.

## `<SideDrawer>` — Canonical Sheet pattern (row-detail + contextual surfaces)

Authoritative source: [`SideDrawer.tsx`](./SideDrawer.tsx) (authored by HUB-1611).

**Use when:** a row-click or button-click should surface detailed / contextual information **without** taking the operator off the underlying view. Slides in from the right edge; the left content stays visible AND interactive (non-modal). Consumers needing a true blocking modal use [`ConfirmDestructive`](./ConfirmDestructive.tsx) instead.

- Audit Log Explorer row detail (HUB-1558 / E-FE-12)
- Customer Health row drawer (HUB-1567 / E-FE-9)
- Failed Payment Tracker row drawer (HUB-1568 / E-FE-13)
- Settings operator edit (HUB-1564 / E-FE-6)
- Any future "click row → see full detail" pattern

**Required for any row-detail / contextual surface in HUB-1546 v0.1.** Re-implementing the pattern in a downstream Epic is an automatic R1 BLOCK.

### Minimum usage

```tsx
import { useState } from 'react';
import { SideDrawer } from '../components/SideDrawer';

const [openRow, setOpenRow] = useState<AuditRow | null>(null);

<SideDrawer
  open={openRow !== null}
  onClose={() => setOpenRow(null)}
  title={openRow ? `${openRow.action} · ${openRow.entityType}` : ''}
  size="md"
>
  <pre>{JSON.stringify(openRow?.detail, null, 2)}</pre>
</SideDrawer>
```

### Use with `urlParam` for deep-linkable drawer state

When a drawer's open state should be shareable (paste URL in a new tab to land on the same row detail), pass `urlParam`:

```tsx
<SideDrawer
  open={open}
  onClose={() => setOpen(false)}
  title="Audit detail"
  urlParam="audit"
>
  ...
</SideDrawer>
```

URL `?audit=1` opens the drawer on mount; closing removes the param; browser back closes the drawer.

### Behavior contract

| State | Behavior |
|---|---|
| Close button (×) | Triggers `onClose`; returns focus to the trigger element |
| Escape key | Triggers `onClose`; window-level listener (does not require focus inside drawer) |
| Click on left content | Drawer stays open (Sheet pattern; left content remains interactive) |
| Browser back when `urlParam` set | Triggers `onClose` so consumer state mirrors URL |
| Tab key | Cycles within drawer via `focus-trap-react` |
| `size` prop | `sm`=320px, `md`=480px (default), `lg`=640px container widths |

### A11y guarantees

- `role="dialog"`, `aria-modal="false"` (intentionally non-modal so AT users are not trapped)
- `aria-labelledby` mapped to the title heading
- Focus trapped within drawer via `focus-trap-react`
- Focus returns to the originating trigger element on close
- Respects `prefers-reduced-motion: reduce` (skips slide transition)
- WCAG 2.1 AA verified via `vitest-axe` integration test

### What `<SideDrawer>` does NOT do

- It does NOT render a backdrop — that's the `<ConfirmDestructive>` modal pattern, not the Sheet pattern.
- It does NOT manage open state — the consumer owns it (`open` + `onClose` props).
- It does NOT auto-open from the URL when `urlParam` is set on mount — the consumer reads the same param and sets `open=true`. The component handles the SYNC (open → URL, URL removed → onClose), not the initial read.
- It does NOT fetch data — consumers pass already-loaded content via `children`.

## `<DataTable<T>>` — Canonical table pattern (generic + searchable + sortable + paginated)

Authoritative source: [`DataTable.tsx`](./DataTable.tsx) (authored by HUB-1601).

**Use when:** any list view needs tabular rendering with search / sort / pagination. Generic typing means rows are typed per-screen; nothing is downcast. Zero external table dependencies (no react-table, no ag-grid) — pure React + Tailwind tokens.

- Audit Log result table (HUB-1614 / E-FE-12)
- SDK Version Distribution + breakdown (HUB-1560 / E-FE-10)
- Plan Advisor recommendation list (HUB-1561 / E-FE-4)
- Settings tables (HUB-1564 / E-FE-6)
- Pricing Scenario history / outcome list (HUB-1565 / E-FE-11)
- Customer Health roster (HUB-1567 / E-FE-9)
- Failed Payment Tracker queue (HUB-1568 / E-FE-13)

**Required for any list view in HUB-1546 v0.1.** Re-implementing the pattern in a downstream Epic is an automatic R1 BLOCK.

### Minimum usage

```tsx
import { DataTable, type ColumnDef } from '../components/DataTable';

interface AuditRow { id: string; actor: string; action: string; createdAt: string; }

const columns: ColumnDef<AuditRow>[] = [
  {
    key: 'createdAt',
    header: 'Timestamp',
    render: (r) => new Date(r.createdAt).toLocaleString(),
    sortable: true,
    sortValue: (r) => new Date(r.createdAt),
  },
  { key: 'actor', header: 'Actor', render: (r) => r.actor, searchValue: (r) => r.actor },
  { key: 'action', header: 'Action', render: (r) => r.action, searchValue: (r) => r.action },
];

<DataTable<AuditRow>
  columns={columns}
  rows={rows}
  rowKey={(r) => r.id}
  ariaLabel="Audit log entries"
  searchableColumns={['actor', 'action']}
  defaultSort={{ key: 'createdAt', direction: 'desc' }}
  loading={loading}
  error={error}
  emptyState={<span>No audit entries match your filters.</span>}
  onRowClick={(row) => setSelectedRow(row)}
/>
```

### Behavior contract

| State / Action | Behavior |
|---|---|
| Search input | Case-insensitive substring filter across `searchableColumns` via each col's `searchValue`. Hidden when `searchableColumns` is omitted or empty. |
| Click sortable header | Cycles `asc → desc → none`. `aria-sort` reflects current state. Sort uses `sortValue` extractor; columns without `sortValue` are not sortable. |
| Pagination | Client-side; default `pageSize=50`. Prev / Next disable at boundaries. Page index resets to 0 when filter / sort / row count changes invalidate the current page. |
| `loading={true}` | Renders 5 skeleton rows; real rows hidden; pagination hidden. |
| `error="…"` | Renders `role="alert"` with the message; rows + pagination hidden. |
| Empty (0 filtered rows) | Renders `emptyState` prop or default `"No matching entries."`. |
| Row click | When `onRowClick` is provided, rows become focusable (`tabIndex=0`) + clickable + keyboard-activatable (Enter / Space). When omitted, rows are inert. |

### A11y guarantees

- Semantic `<table>` + `<thead>` + `<tbody>` with `aria-label` on the table itself
- Column headers `role="columnheader"` (implicit on `<th>`) with `aria-sort` on sortable columns
- Sortable headers are `<button>` elements (keyboard-activatable)
- Search input has computed `aria-label` (e.g., `"Search Audit log entries"`)
- Pagination controls labeled `"Previous page"` / `"Next page"`; page status announced via `aria-live="polite"`
- Skeleton rows respect `prefers-reduced-motion: reduce` (animation suppressed)
- WCAG 2.1 AA verified via `vitest-axe` (zero violations in populated + empty states)

### What `<DataTable>` does NOT do

- It does NOT fetch data — consumer passes `rows` already loaded.
- It does NOT do server-side pagination — `pageSize` paginates the rows you pass in. For >1000-row tables, consumers need a controlled-mode variant + virtualization (out of scope at v0.1; flag for downstream Epic).
- It does NOT handle row selection / checkboxes — that's a column-renderer concern for v0.2 if it surfaces.
- It does NOT manage the loading/error state — consumer passes booleans/strings; the table renders the appropriate shell.

## `<TabbedDetailView>` — Cross-Epic tabbed-detail pattern

Authoritative source: [`TabbedDetailView.tsx`](./TabbedDetailView.tsx) (authored by HUB-1602).

**Use when** a route renders a detail view with multiple tabbed sub-sections — product detail, settings detail, customer detail. Inherit it instead of re-implementing the tab strip + ARIA pattern.

### What it does

- **Tab strip** with active-tab visual distinction (sailcloth tint + brass bottom-border accent per HUB-1571 tokens).
- **URL deep-link sync** — active tab id is mirrored to a configurable URL query param (default `tab`). Browser back/forward "just works." Other URL params (e.g. drawer `eventId`) are preserved on tab change.
- **Per-tab error boundary** — if one tab's content throws, its `errorFallback` renders while the other tabs stay functional. Keyed by tab id so switching to a working tab resets the boundary cleanly.
- **Lazy render** — only the active tab's content is mounted; inactive tabs are unmounted entirely. Pass `content` as a thunk (`() => ReactNode`) to defer expensive computation until the tab is opened.
- **WAI-ARIA tabs pattern** — `role="tablist"` / `role="tab"` / `role="tabpanel"`, `aria-selected`, `aria-controls`. Keyboard: ←/→ between tabs (wrap-around), Home/End jump to first/last, Tab moves into the panel.

### Minimum usage

```tsx
import { TabbedDetailView, type TabDef } from '../components/TabbedDetailView';

const tabs: TabDef[] = [
  { id: 'overview', label: 'Overview', content: <OverviewTab productId={id} /> },
  { id: 'plans', label: 'Plans', content: () => <PlansTab productId={id} /> },
  { id: 'audit', label: 'Audit', content: <AuditTab productId={id} />, badge: <span>3</span> },
];

<TabbedDetailView tabs={tabs} defaultTab="overview" ariaLabel="Product detail" />
```

### When NOT to use

- **Non-tab navigation** — for top-level route navigation use React Router, not this primitive.
- **Persistent cross-tab state** — lazy render unmounts inactive tabs. If a tab's state must survive a switch, lift it into a store (Zustand) above the `<TabbedDetailView>`.
- **More than ~6 tabs** — the horizontal strip degrades at higher counts; consider a sidebar nav pattern instead.

## `<MetricTile>` — Cross-Epic metric tile pattern

Authoritative source: [`MetricTile.tsx`](./MetricTile.tsx) (authored by HUB-1620).

**Use when** a route renders a portfolio of metrics-per-entity (compliance posture per product, SDK versions per product, system health per service, customer health per account). Inherit it instead of re-implementing the title + value + verdict triple.

### What it does

- **Triple-encoded verdict** — color (HUB-1571 semantic palette) + glyph (SVG icon per verdict) + text label (`healthy` / `warning` / `error` / `neutral`). WCAG AA: color alone is insufficient, so the glyph + text always travel with the color.
- **Auto-composed aria-label** — `"{title}: {value} {unit}, {verdict label}"` so screen readers get the full semantic in one announcement. Override via `ariaLabel` when the consumer wants a tailored phrasing.
- **Empty state** — `value={null | undefined | ''}` renders an em-dash with `aria-label="No data"` so SR users don't hear "dash."
- **Loading skeleton** — matches the loaded tile's `h-[160px]` dimensions so CLS stays under 0.1.
- **Click-through** — passing `onClick` makes the whole tile keyboard-activatable: `role="button"`, `tabIndex=0`, Enter/Space invoke. Without it the tile is `role="group"` and non-tabbable.
- **Drift badge** — optional corner badge with `↑ +5` / `↓ −10` / `→` for delta visualization; carries its own aria-label so SR users hear "trending up: +5."

### Minimum usage

```tsx
import { MetricTile } from '../components/MetricTile';

<MetricTile
  title="Compliance posture for ContentHelm"
  value={92}
  unit="%"
  verdict="success"
  drift="up"
  driftLabel="+5"
  onClick={() => navigate(`/console/compliance/${productId}`)}
/>
```

### When NOT to use

- **Single number on a detail page** — overkill; use a plain `<dt>/<dd>` row instead.
- **Sparkline or chart context** — pair with `<TimelineChart>` (HUB-1621) inside a tile's footer slot rather than substituting one for the other.
- **More than ~16 tiles on a page** — at that scale switch to a `<DataTable>` for scan-ability; tiles work for ≤16-entity portfolios.

## `<TimelineChart>` — Cross-Epic time-series pattern

Authoritative source: [`TimelineChart.tsx`](./TimelineChart.tsx) (authored by HUB-1621).

**Use when** a route renders a time-series of one metric with optional annotations (compliance posture over 90 days, system response time over the week, customer engagement over the quarter).

### What it does

- **Inline SVG line chart** — no Recharts / D3 / chart library dependency at v0.1 (LK-134 lives in a separate repo; bundle-budget-friendly). The public surface matches the spec props so a one-file swap to recharts is trivial once HUB consumes the LK substrate.
- **Severity-coloured annotations** — `info` / `warning` / `error` markers as dashed vertical lines with native `<title>` tooltips.
- **valueFormat variants** — `integer` / `percent` / `currency` for y-tick labels.
- **States covered** — `loading` (skeleton with the same height to keep CLS<0.1), `error` (alert banner), empty (no-data message rather than an empty axis).
- **A11y**: chart container is `role="img"` with an auto-composed aria-label that summarizes the trend (`"Compliance % timeline, 90 days, current 92, trend up"`) and an SR-only `<table>` fallback so screen-reader users can step through point-by-point. Override the label via `ariaLabel` when a tailored phrasing is wanted.

### Minimum usage

```tsx
import { TimelineChart } from '../components/TimelineChart';

<TimelineChart
  data={[
    { date: '2026-04-01', value: 80 },
    { date: '2026-05-01', value: 85 },
    { date: '2026-06-01', value: 92 },
  ]}
  yLabel="Compliance %"
  valueFormat="percent"
  annotations={[
    { date: '2026-05-01', label: 'SOC 2 audit kickoff', severity: 'info' },
  ]}
/>
```

### When NOT to use

- **Categorical data** (a bar chart of products by status) — pair `<DataTable>` with `<MetricTile>` instead.
- **Multi-series overlays** — v0.1 supports a single series. Add multi-series support in a follow-up story when a consumer needs it.

## `<DistributionChart>` — Cross-Epic categorical-distribution pattern

Authoritative source: [`DistributionChart.tsx`](./DistributionChart.tsx) (authored by HUB-1630).

**Use when** a route renders a categorical distribution: SDK version → product count (HUB-1632), plan tier → customer count (HUB-1561), churn risk → customer count (HUB-1567), service status → incident count (HUB-1566).

### What it does

- **Inline SVG bar chart** — same rationale as `<TimelineChart>` (no Recharts / D3 dependency at v0.1; bundle-budget friendly; LK-134 swap is a one-file change).
- **Two layouts** — `vertical` (default; bars stand up, x-axis = category) or `horizontal` (bars lie sideways, good for long category labels like `"Synapz v2.7.18-rc.3"`).
- **Hover tooltip** with category + count + optional item list (e.g., on the SDK-versions chart, hovering a v1.5 bar surfaces the products on that version).
- **Total label** above the chart summing all categories (`Total: 12 products`). Unit configurable via `totalUnit` prop.
- **A11y**: chart container is `role="img"` with an auto-composed summary aria-label (top-3 categories by count), plus a visually-hidden `<table>` fallback for SR users to step through point-by-point.

### Minimum usage

```tsx
import { DistributionChart } from '../components/DistributionChart';

<DistributionChart
  data={[
    { category: 'v1.5', count: 8, items: ['Synapz', 'ContentHelm'] },
    { category: 'v1.4', count: 3, items: ['LaunchKit'] },
    { category: 'v1.3', count: 1 },
  ]}
  xLabel="SDK Version"
  yLabel="Products"
  totalUnit="products"
/>
```

### When NOT to use

- **Time-series data** — use [`<TimelineChart>`](./TimelineChart.tsx) instead.
- **More than ~12 categories** — bars cram together; switch to `<DataTable>` for scan-ability.
- **Continuous numeric distributions** — histograms aren't the same as categorical distributions; a separate primitive would be appropriate.

## `<PlanComparison>` — Cross-Epic "before vs after" plan pattern

Authoritative source: [`PlanComparison.tsx`](./PlanComparison.tsx) (authored by HUB-1637).

**Use when** a route renders two plan states side-by-side for the operator to compare: advisor current-vs-recommended (HUB-1640), pricing-model baseline-vs-proposed (HUB-1563), scenario A-vs-B (HUB-1565).

### What it does

- **Paired cards** — desktop (`lg`) side-by-side, narrower viewports stacked. Each card is a `<section aria-labelledby>` carrying its own heading (default `Current` / `Recommended`; override via `leftLabel` / `rightLabel`).
- **Field-level delta detection** when `highlightDeltas` is true (default):
  - **Price** — numeric diff; right card surfaces a `↑ +$50` / `↓ −$30` chip with semantic color (seafoam for increase, ironwake for decrease). Each chip carries a descriptive aria-label like `"Price changed from $99/mo to $149/mo, increased by $50"`.
  - **Billing mode** — string equality; differing values get a subtle highlight on the right card.
  - **Features** — set diff. Added features highlight green on the right card; removed features strike-through red on the left card. Shared features render neutral.
- **Reasoning bullets** — optional `<ol>` below the cards. Each `<li>` is keyboard-reachable (`tabIndex=0`) so screen-reader users can step through the bullets without arrow-key fighting.
- **Loading skeleton** matches the two-card layout to keep CLS under 0.1.
- **Empty card** — `left={null}` or `right={null}` renders the "No current plan assigned" placeholder per AC#6.

### Minimum usage

```tsx
import { PlanComparison } from '../components/PlanComparison';

<PlanComparison
  left={{ title: 'Standard $99', price: 99, billingMode: 'standard', features: ['API access'] }}
  right={{ title: 'Pro $149', price: 149, billingMode: 'credit', features: ['API access', 'Priority support'] }}
  reasoningBullets={[
    'Usage exceeded standard tier rate limits for 14 of the last 30 days.',
    'Credit billing aligns with the customer’s annual budget cadence.',
  ]}
/>
```

### When NOT to use

- **More than 2 plans** to compare — wrap multiple `<PlanComparison>` instances in tabs, or use a `<DataTable>` for a row-per-plan comparison.
- **Non-plan data** — this primitive is opinionated about Price / Billing / Features. For arbitrary key/value comparison, build a smaller helper.

## Server-side RBAC invariant (cross-component reminder)

All client-side gates in this module (including `<RBACRoute>` from HUB-1574) are UX-layer only. Server-side endpoints MUST enforce their own RBAC and return 403 for unauthorized requests. Client guards exist to keep the UI honest; they are not a security boundary. See [`../lib/rbac.ts`](../lib/rbac.ts) module-level documentation.

### Full-page denial UX (`<AccessDeniedPage>`, HUB-1609)

When a server-side RBAC check returns 403, surface the canonical [`<AccessDeniedPage>`](./AccessDeniedPage.tsx) instead of a generic error banner. The page is **distinct from a 404**: it tells the operator "you can't see this" rather than "this doesn't exist," and supplies escalation copy ("ask Sammy to grant access").

Used by:
- `/console/products` (HUB-1603) — when the portfolio fetch returns 403 (operator lacks any product scope)
- `/console/products/:productId` (HUB-1604) — when the deep-link target is outside the operator's scope (URL-hack scenario per HUB-1609 AC#2)
- Future surfaces with per-resource RBAC: invoke when the relevant fetch throws `PermissionDeniedError`

The page focuses its back-link on mount so SR users hear the denial announcement via `role="alert"` and have a keyboard target one Tab away.

### Per-resource RBAC (HUB-1618)

Some endpoints enforce RBAC at the **resource** level via query params — not just at the route level. The canonical example is the audit log:

- `GET /api/v1/admin/console/audit-log?product_id=<X>` returns **403** when `<X>` is outside the requesting operator's product scope, even though the route itself is open to `product_admin`.

This means an operator can paste a deep-link URL (`/console/audit?product_id=<out-of-scope>`) and reach a page they're authorized to view, but the data fetch will fail. The UI handles this by:

1. Surfacing an inline error with guided next-step text.
2. Clearing the offending param from local filter state (other filters preserved).
3. Re-firing the fetch automatically (now without the bad param), so the operator sees their in-scope data instead of an empty screen.

The server remains authoritative — the client never filters by scope on its own.

### Per-path-param RBAC (HUB-1628 — compliance)

The compliance endpoints enforce RBAC at the **path-parameter** level:

- `GET /api/v1/admin/compliance/portfolio` — server returns only scope-allowed products for `product_admin`. The FE renders what the server returns without additional client-side filtering.
- `GET /api/v1/admin/compliance/:productId` — server returns **403** when `:productId` is outside the operator's scope (URL-hack scenario). The FE catches `PermissionDeniedError` and renders `<AccessDeniedPage>` with a back-link to `/console/compliance` — distinct from the not-found state because compliance data may carry sensitive control evidence and the user needs to know they're being denied, not that the product is missing.

Same invariant as HUB-1618: server authoritative. The compliance view never client-side filters scope.
