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

## Server-side RBAC invariant (cross-component reminder)

All client-side gates in this module (including `<RBACRoute>` from HUB-1574) are UX-layer only. Server-side endpoints MUST enforce their own RBAC and return 403 for unauthorized requests. Client guards exist to keep the UI honest; they are not a security boundary. See [`../lib/rbac.ts`](../lib/rbac.ts) module-level documentation.
