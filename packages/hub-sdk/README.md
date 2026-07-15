# @maverick-launch/hub-sdk

Node.js client SDK for the Maverick Launch HUB — the internal control plane every Fair Winds product connects to for entitlements, signed-lease enforcement, usage tracking, and BI metric push.

> **Get started in 5 minutes.** Sections below take you from `npm install` to seeing your first metric in the HUB Console. If HUB is running locally per `the-hub/README.md`, everything works against `http://localhost:3000` out of the box.

## Table of contents

1. [Install](#1-install)
2. [Environment variables](#2-environment-variables)
3. [Bootstrap the HubClient](#3-bootstrap-the-hubclient)
4. [Your first metric push](#4-your-first-metric-push)
5. [Your first entitlement check](#5-your-first-entitlement-check-lease)
6. [Troubleshooting](#6-troubleshooting)
7. [Requirements](#7-requirements)

---

## 1. Install

```bash
npm install @maverick-launch/hub-sdk
```

Requires Node.js >= 20 and an ESM consumer project (`"type": "module"` in `package.json`).

## 2. Environment variables

The wizard at `/console/onboarding` mints these for your app. Put them in `.env.local` (git-ignored) — the wizard's generated Claude Code prompt reminds you to.

| Variable | Example | Where it comes from |
|---|---|---|
| `HUB_BASE_URL` | `http://localhost:3000` (dev) or your production HUB URL | Your ops team |
| `HUB_CLIENT_ID` | UUID | Onboarding wizard, S1 or S2 rotate reveal |
| `HUB_CLIENT_SECRET` | 43-char base64url | Onboarding wizard — **shown once**; store immediately |
| `LEASE_ENCRYPTION_KEY` | 32-byte base64 | Ops-managed; required if your app calls `getLease()` |

If your ops team hasn't run you through the wizard yet, ask them to visit `/console/onboarding` → Register new. It takes 30 seconds.

## 3. Bootstrap the HubClient

Create `src/hub/client.ts` (or the equivalent in your app):

```ts
import { HubClient, MetricsClient } from '@maverick-launch/hub-sdk';

if (!process.env.HUB_BASE_URL) throw new Error('HUB_BASE_URL missing');
if (!process.env.HUB_CLIENT_ID) throw new Error('HUB_CLIENT_ID missing');
if (!process.env.HUB_CLIENT_SECRET) throw new Error('HUB_CLIENT_SECRET missing');

export const hub = new HubClient({
  clientId: process.env.HUB_CLIENT_ID,
  clientSecret: process.env.HUB_CLIENT_SECRET,
  hubUrl: process.env.HUB_BASE_URL,
});

export const metrics = new MetricsClient({
  hubUrl: process.env.HUB_BASE_URL,
  getBearerToken: async () => {
    await hub.connect();
    // HubClient handles OAuth2 client-credentials refresh internally; this bridge
    // exposes the current token so MetricsClient can Bearer-auth its POSTs.
    return (hub as unknown as { token: string }).token;
  },
});

metrics.startFlushLoop();
```

Then call `hub.connect()` at app startup. If your credentials are wrong or HUB is unreachable, `connect()` throws with a clear reason.

## 4. Your first metric push

The HUB metric catalog exposes these names (see `src/services/bi/metricCatalog.ts` on the HUB side for the full spec). Pushing any name outside this list is silently dropped by HUB and audited under `bi.metric.unknown_metric`.

- `daily_active_users` — int, sum semantic
- `logins` — int, sum semantic
- `mrr_cents` — int, last semantic
- `churn_rate` — float, avg semantic
- `feature_adoption` — float, avg semantic (requires `feature` dimension)
- `app_health_status` — enum `ok|degraded|down`, last semantic

Example — daily active users push at end of day:

```ts
import { metrics } from './hub/client.js';

// e.g. in your DAU-computation cron
metrics.push('daily_active_users', 500);
```

Example — feature adoption with a dimension:

```ts
metrics.push('feature_adoption', 0.42, {
  dimensions: { feature: 'export_csv' },
});
```

The `MetricName` type is a string-literal union — a typo fails at compile time. If you're pushing a metric name from configuration (dynamic), the SDK also exports `isKnownMetricName(name)` for runtime validation.

Metrics are buffered locally and flushed every 30 seconds (or when the buffer hits 100 events). To force a flush during shutdown:

```ts
await metrics.flush();
metrics.stopFlushLoop();
```

## 5. Your first entitlement check (lease)

`getLease(tenantId, productId)` returns the current cryptographically-signed lease for that tenant. Cached locally per-tenant; refreshed on TTL expiry.

```ts
import { hub } from './hub/client.js';
import { HubKillSwitchError, HubLeaseInvalidError } from '@maverick-launch/hub-sdk';

try {
  const lease = await hub.getLease(tenantId, productId);
  if (lease.entitlements.includes('premium_export')) {
    // allow the feature
  }
} catch (e) {
  if (e instanceof HubKillSwitchError) {
    // operator-triggered kill-switch — render a "subscription suspended" UX
  } else if (e instanceof HubLeaseInvalidError) {
    // HUB unreachable + cache expired — degrade gracefully
  }
}
```

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `TypeError: clientId is required` | Env vars didn't load | Confirm `.env.local` exists + your bootstrap loads it before `new HubClient()` |
| `HubAuthError: Authentication failed after retry` | Wrong `HUB_CLIENT_SECRET` OR credential was rotated | Ask ops to re-issue via `/console/onboarding` → Manage → Rotate credential |
| `HubLeaseInvalidError: LEASE_ENCRYPTION_KEY … required` | You called `getLease()` without setting `LEASE_ENCRYPTION_KEY` | Set the env var (32-byte base64) before `hub.connect()` |
| Metrics pushed but not visible in the Dashboard | Metric name typo (silently dropped) OR waiting on hourly rollup | Check HUB `audit_log` for `bi.metric.unknown_metric` entries under your product_id; if empty, wait ≤15 min for the next rollup tick |
| `HubKillSwitchError` | Operator kill-switched your tenant | Contact your account owner or HUB super_admin to un-revoke |

## 7. Requirements

- Node.js >= 20
- ESM consumer project (`"type": "module"` in `package.json`)

<!-- TODO-D-DEF-006: TypeScript-only SDK at v1. SDK languages beyond TypeScript not yet decided. -->

## See also

- `docs/hub-sdk-example-integration.md` — full walkthrough of the Manifest reference integration
- `/console/onboarding` in the HUB Console — self-service registration + rotation
- `src/services/bi/metricCatalog.ts` in the HUB repo — canonical metric name + semantics registry
