# Wire this codebase to HUB — GREENFIELD path

You are Claude Code, working inside a brand-new application repository built on the
LaunchKit substrate. The mount points are already there — this is short. Your mission:
install the HUB SDK, wire the client, and push a starter metric so the operator can
verify end-to-end.

The Onboarding wizard fills in credentials + HUB URL when it emits this prompt.
Placeholders you'll see substituted:

- `{{PRODUCT_ID}}` — HUB's product UUID
- `{{PRODUCT_NAME}}` — display name
- `{{PRODUCT_SLUG}}` — url-safe slug
- `{{PRODUCT_TYPE}}` — `saas` | `internal_only` | `workbench` | `ai_service`
- `{{HUB_BASE_URL}}` — where the app calls
- `{{HUB_CLIENT_ID}}` — this product's OAuth2 client id
- `{{HUB_CLIENT_SECRET}}` — one-time plaintext secret (⚠️ handle with care)
- `{{METRICS_BLOCK}}` — the metric names this product_type is allowed to push

---

## Step 1 — Add credentials (⚠️ DO NOT commit)

⚠️ Confirm `.env.local` is in `.gitignore` BEFORE writing the secret. LaunchKit
scaffolds ship with `.env.local` already ignored — verify anyway.

Add to `.env.local`:

```
HUB_BASE_URL={{HUB_BASE_URL}}
HUB_CLIENT_ID={{HUB_CLIENT_ID}}
HUB_CLIENT_SECRET={{HUB_CLIENT_SECRET}}
```

Add matching empty entries to `.env.example`.

## Step 2 — Install the SDK

```
npm install @maverick-launch/hub-sdk
```

## Step 3 — Bootstrap the HubClient

Create `src/hub/client.ts`:

```ts
// Authorized by {{GREENFIELD_STORY_KEY}} — HUB integration for a fresh LaunchKit app.
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

Fill `{{GREENFIELD_STORY_KEY}}` with the Jira key for this greenfield story.

## Step 4 — Mount the LaunchKit pricing + gate slots

*(When the SDK's PricingProvider surface ships — LK-4729 Epic — this step lands its
final form. Until then, LaunchKit's `<PricingSlot />` and `<AuthGateSlot />` render a
neutral placeholder that reads config to know it's HUB-backed but stays visually
neutral.)*

In the app's root layout:

```tsx
import { PricingSlot, AuthGateSlot } from '@launchkit/substrate';
import { hub } from '@/hub/client';

<AuthGateSlot provider={hub}>
  <PricingSlot provider={hub} />
  {/* app routes */}
</AuthGateSlot>
```

If either import isn't available yet (SDK pricing surface not shipped), leave the
imports at the top with a `// TODO: HUB pricing wiring — LK-4729` note and continue.

## Step 5 — Push your first metric

The HUB metric catalog for `{{PRODUCT_TYPE}}` exposes these names:

{{METRICS_BLOCK}}

Put a starter push at whatever computation site fits the app's shape — for a fresh
scaffold that's usually the daily cron the LaunchKit template ships with. Example:

```ts
import { metrics } from '@/hub/client';

// e.g. at end-of-day cron
metrics.push('daily_active_users', await countActiveSessions());
```

**Do not fabricate values just to make the push work.** If the app doesn't have real
usage yet, leave the push commented with a TODO explaining what the number will be.

## Step 6 — Verify

1. Run `npm run dev`. Watch the logs for HubClient connect (no 401 from POST
   `/api/v1/auth/token`).
2. In the HUB Console, open `/console/products/{{PRODUCT_ID}}/bi` and confirm the
   metric appears within ~15 min.
3. Log in / log out of the app locally to exercise the `<AuthGateSlot>` — even
   though the slot is a neutral placeholder today, it should not throw.

## Step 7 — Report

Reply to the operator with:

- The Jira key of this story (`{{GREENFIELD_STORY_KEY}}`).
- File list of what was created.
- Verification results — literal HTTP status codes / dashboard tile values, not vibes.

## Test-run checklist before you claim done

- [ ] `npm test` — no failures
- [ ] Typecheck clean
- [ ] Lint clean
- [ ] App logs show one successful connect + one successful ping to HUB
- [ ] At least one metric visible in the HUB BI dashboard for this product
- [ ] `.env.local` NOT staged for commit; `.env.example` staged with empty values
