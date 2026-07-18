# Wire this codebase to HUB — RETROFIT path

You are Claude Code, working inside an existing application repository that has its own
auth, routes, and (probably) some hand-rolled pricing or metrics code. Your mission: wire
this application to HUB so it can push BI metrics and check entitlements, **without
silently rewriting existing working code**. This doc is authoritative for retrofit; if
anything is ambiguous, PAUSE and ask the operator (do not guess).

The Onboarding wizard fills in credentials + HUB URL when it emits this prompt for a
specific product. Placeholders you'll see substituted:

- `{{PRODUCT_ID}}` — HUB's product UUID
- `{{PRODUCT_NAME}}` — display name
- `{{PRODUCT_SLUG}}` — url-safe slug
- `{{PRODUCT_TYPE}}` — `saas` | `internal_only` | `workbench` | `ai_service`
- `{{HUB_BASE_URL}}` — where the app calls
- `{{HUB_CLIENT_ID}}` — this product's OAuth2 client id
- `{{HUB_CLIENT_SECRET}}` — one-time plaintext secret (⚠️ handle with care)
- `{{METRICS_BLOCK}}` — the metric names this product_type is allowed to push

---

## Step 1 — Confirm baseline (no writes yet)

Before touching anything, gather signal:

1. Confirm Node version — needs `>=20` for the SDK.
2. Confirm this app is NOT already talking to HUB. Grep for:
   - `@maverick-launch/hub-sdk` in `package.json`
   - `HUB_BASE_URL` / `HUB_CLIENT_ID` in `.env*` files
   - `HubClient` / `MetricsClient` imports in source
3. Identify existing hand-rolled code that HUB will eventually replace:
   - **Auth / session** — is there a login/refresh loop the app owns today?
   - **Pricing / plans** — hardcoded tiers? DB tables? Config files?
   - **Entitlement gating** — where does the app decide "past-due, block access"?
   - **Metrics / analytics** — Segment? PostHog? A homegrown counter?

**Report the findings back to the operator.** If any of the above already exists, PAUSE.
The operator decides whether this retrofit story owns the deletion of that code or
whether a follow-up story does. Do NOT delete anything on your own initiative.

## Step 2 — Add credentials (⚠️ DO NOT commit)

⚠️ **Confirm `.env.local` is in `.gitignore` BEFORE writing the secret.** If it isn't,
stop and add it first. Same rule for whatever local-secrets file this repo uses
(`.env.development.local`, `apps/*/.env.local`, etc. — check the repo's actual pattern).

Add to `.env.local` (or the app's platform secret store):

```
HUB_BASE_URL={{HUB_BASE_URL}}
HUB_CLIENT_ID={{HUB_CLIENT_ID}}
HUB_CLIENT_SECRET={{HUB_CLIENT_SECRET}}
```

Add matching entries to `.env.example` with **EMPTY values only** so contributors know
these vars exist without seeing the secret.

## Step 3 — Install the SDK

```
npm install @maverick-launch/hub-sdk
```

(Use whatever package manager the repo already standardizes on — pnpm/yarn/bun. Do
not switch package managers as part of this story.)

## Step 4 — Bootstrap the HubClient

Create `src/hub/client.ts` (or the equivalent path this codebase uses for
infrastructure clients):

```ts
// Authorized by {{RETROFIT_STORY_KEY}} — HUB retrofit wiring.
import { HubClient, MetricsClient } from '@maverick-launch/hub-sdk';

export const hub = new HubClient({
  clientId: process.env.HUB_CLIENT_ID!,
  clientSecret: process.env.HUB_CLIENT_SECRET!,
  hubUrl: process.env.HUB_BASE_URL!,
});

export const metrics = new MetricsClient({
  hubUrl: process.env.HUB_BASE_URL!,
  getBearerToken: async () => {
    await hub.connect();
    return (hub as unknown as { token: string }).token;
  },
});

metrics.startFlushLoop();
```

Fill `{{RETROFIT_STORY_KEY}}` with the Jira key the operator gave you for this
retrofit story (per ironclad-engineer file-authorization rule).

## Step 5 — Reconciliation checklist (⏸ PAUSE point)

**Before doing any of the sub-steps below, present this list to the operator and get
explicit go/no-go on each one.** Reconciliation is destructive — you are removing
code the app already runs against.

- [ ] **Existing pricing display** — replace with `<PricingDisplay provider={hub} />`
      once the SDK's PricingProvider surface ships. Until then, leave a `// TODO:
      HUB pricing wiring` at the render site and continue.
- [ ] **Existing entitlement gate** — replace with `<EntitlementGate />` at the same
      site. Same TODO fallback until the SDK ships that surface.
- [ ] **Existing metric emitters** — for each existing emitter, decide: (a) route
      through `metrics.push()` and delete the old path, (b) keep both temporarily
      for shadow comparison, or (c) skip HUB emission for this metric (why?).
- [ ] **Existing auth loop** — HUB does NOT replace end-user auth. HUB's client-
      credentials flow is app-to-HUB only. If the app has its own end-user JWT/
      session, leave it alone.

Wait for the operator's decision on each row before touching code. Any row the
operator defers becomes a new follow-up story.

## Step 6 — Push your first metric

The HUB metric catalog for `{{PRODUCT_TYPE}}` exposes these names — pushing any name
outside this list is silently dropped by HUB and audited:

{{METRICS_BLOCK}}

Pick an existing computation site that already has the number handy (session count,
active user count, subscription MRR, etc.) and add:

```ts
import { metrics } from './hub/client';

metrics.push('daily_active_users', <computed value>);
```

**Do not fabricate values just to make the push work.** If the number isn't real yet,
leave the push commented with a TODO explaining what needs to happen first.

## Step 7 — Verify

1. Run the app. Watch its logs to confirm the HubClient connects (no 401 from POST
   `/api/v1/auth/token`).
2. In the HUB Console, open `/console/products/{{PRODUCT_ID}}/bi` and confirm your
   metric appears within ~15 min (rolls up on the hourly boundary).
3. Trigger the entitlement path (if wired) — confirm a paid tenant sees the app and
   a past-due test tenant is gated.

## Step 8 — Report

Reply to the operator with:

- The Jira key of this story (`{{RETROFIT_STORY_KEY}}`).
- What was actually changed (file list).
- What was deferred (with a follow-up story key or a note that a new story is needed).
- The verification results — literal HTTP status codes / tile values seen, not vibes.

## Test-run checklist before you claim done

- [ ] Existing test suite still passes — no new failures introduced by hub/client.ts
- [ ] Typecheck clean (`tsc --noEmit` or the repo's equivalent)
- [ ] Lint clean
- [ ] App logs show one successful connect + one successful ping to HUB
- [ ] At least one metric visible in the HUB BI dashboard for this product
- [ ] `.env.local` NOT staged for commit; `.env.example` staged with empty values
- [ ] Every reconciliation checkbox from Step 5 has an explicit operator decision
      recorded in the story comments
