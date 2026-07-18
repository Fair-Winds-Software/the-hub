# HUB Integration Docs

Canonical instructions for wiring a Fair Winds product to HUB. Two paths:

- **[RETROFIT.md](RETROFIT.md)** — existing codebase that already has its own auth, routes,
  and (usually) some hand-rolled pricing / metrics. Retrofit is where scope discipline
  matters most; the doc has explicit PAUSE points before anything gets deleted.
- **[GREENFIELD.md](GREENFIELD.md)** — brand-new codebase built on the LaunchKit substrate.
  Much shorter — the mount points are already there.

## How the two paths are used

Both docs are *canonical references* — they describe the pattern in full and stay valid
as the shared source of truth. The Onboarding wizard at `/console/onboarding` calls
`POST /api/v1/admin/onboarding/:productId/prompt` with a `codebase_state` flag; the
service picks the right template, substitutes the real credentials + HUB URL, and
returns a tailored prompt the operator pastes into the target codebase.

Editing the docs here rewrites what the prompt generator emits — keep them in sync
with the runtime template in `src/services/onboardingPromptService.ts`.

## What each connection actually provides today

- **HubClient** — auth (client-credentials → short-TTL JWT), lease + kill-switch
  handling. All apps need this. Ships in `@maverick-launch/hub-sdk`.
- **MetricsClient** — BI event push (`POST /admin/bi/metrics`). All apps need this
  once they have anything worth measuring.
- **UsageClient** — usage-based billing event push. Only needed for metered pricing.
- **PricingProvider** — catalog + entitlement (planned, not yet in the SDK). Retrofit
  and greenfield docs both flag this as "coming; leave a TODO where it will drop in."

## Scope discipline

Retrofit doc leaves the door explicitly open for the operator to say NO before any
deletions. Do not silently rewrite existing hand-rolled pricing or auth code — that
lands on a separate story with its own review gate.
