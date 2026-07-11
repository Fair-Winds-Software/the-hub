# Adding a New External Connection to HUB

> Authorized by HUB-1796 (S7 of HUB-1783). Single-page checklist for adding a new
> external-app integration (analytics provider, CRM, billing sidecar, etc.) to HUB's
> generic connections framework. Follow the steps in order; the Stripe implementation
> is the reference.

The framework is name-parameterized: HUB code depends on `getConnection<T>(name)` and
`getConnectionMode(name)`, never on connection-specific singletons. Adding a new
connection means writing (a) an interface, (b) two adapters, (c) one registration
line, and (d) test variants that plug into the shared contract harness.

## 0. Prerequisites

- Read `src/connections/base.ts` — the `ExternalConnection` interface every adapter
  must implement (`name`, `mode()`, `probe()`).
- Read `src/stripe/connection.ts` — the reference for a domain-specific interface that
  extends `ExternalConnection` with additional facets.
- Read `src/connections/registry.ts` — the multi-connection registry your adapter will
  register with at bootstrap.

## 1. Define your `<Name>Connection` interface

Location: `src/<name>/connection.ts`

Extend `ExternalConnection` with the domain facets HUB will consume. Stripe uses
`balance`, `customers`, `subscriptions`, etc.; a Google Analytics connection would
add `properties`, `reports`, etc.

```ts
import type { ExternalConnection } from '../connections/base.js';

export interface GaConnection extends ExternalConnection {
  readonly properties: GaPropertiesFacet;
  readonly reports: GaReportsFacet;
}
```

**Rule of thumb:** every method HUB code actually calls belongs here. Nothing else
does. Adding to the SDK surface is a Story-scoped decision, not a drive-by.

## 2. Define Zod schemas for response shapes

Location: `src/<name>/schemas.ts`

Every external response HUB depends on gets a Zod schema. Adapters call
`Schema.parse(sdkResponse)` at the boundary so downstream code only ever sees typed,
validated data.

Reference: `src/stripe/schemas.ts` — one schema per response type; discriminated unions
for polymorphic responses (webhook events).

## 3. Implement `Live<Name>Adapter` + `Mock<Name>Adapter`

Location: `src/<name>/liveAdapter.ts` and `src/<name>/mockAdapter.ts`

Both classes MUST implement your `<Name>Connection` interface — which means both
implement `ExternalConnection`:

```ts
export class LiveGaAdapter implements GaConnection {
  readonly name = 'ga';
  mode(): 'live' | 'mock' { return getConnectionMode('ga'); }
  async probe(): Promise<ProbeResult> {
    const start = Date.now();
    await this.properties.list(); // or whatever a cheap "am I healthy" call is
    return { health: 'ok', latency_ms: Date.now() - start };
  }
  // ...domain facets
}

export class MockGaAdapter implements GaConnection {
  readonly name = 'ga';
  mode(): 'live' | 'mock' { return 'mock'; }
  async probe(): Promise<ProbeResult> { return { health: 'ok', latency_ms: 0 }; }
  // ...domain facets backed by PG mock schema (see step 4)
}
```

**Timeout + error mapping:** wrap SDK calls in `withStripeTimeout()`-equivalent helpers
so callers see `AppError`, not raw SDK types. Reference: `src/stripe/client.ts`.

**Idempotency:** if your API supports it, thread `idempotencyKey` through mutation
options. Live: pass to SDK. Mock: record against an idempotency store and short-circuit
repeats.

## 4. Optional: PG schema for persistent mock state

If your MockAdapter needs persistent state (Stripe's mock stores products,
subscriptions, invoices, etc. in `stripe_mock.*`), add a PG migration:

- `db/migrations/NNN_create_<name>_mock_schema.sql` creates `<name>_mock.<table>`
  tables mirroring what Live returns.
- Include a `universal_delta_tracker` trigger if downstream tests inspect deltas.

Reference migrations: `db/migrations/067_create_stripe_mock_schema.sql` and the
follow-on structured-table migrations.

## 5. Register at bootstrap

Location: `src/<name>/registry.ts`

Follow the Stripe shim pattern (`src/stripe/registry.ts`):

```ts
function ensureRegistered(): void {
  if (_registered) return;
  registerConnection({
    name: 'ga',
    buildLive: () => new LiveGaAdapter(),
    buildMock: () => new MockGaAdapter(),
    hasLiveCredentials: () => Boolean(process.env.GA_CLIENT_ID && process.env.GA_CLIENT_SECRET),
  });
  _registered = true;
}

export async function initGaRegistry(): Promise<void> {
  ensureRegistered();
  await initConnectionsRegistry();
}
```

Call `initGaRegistry()` from `src/index.ts` at boot. Missing LIVE credentials with
`mode=live` in production is a fail-fast per the registry contract.

## 6. Settings-cache key (auto)

Mode persistence is handled by the generic registry — the settings key is derived
automatically as `connection_mode.<name>`. You do not write any settings-cache code.
Bootstrap reads the row; `setConnectionMode(name, target, actor)` writes the row +
invalidates the cache + emits an audit log entry.

## 7. Contract tests — plug into the shared harness

Location: `src/<name>/__tests__/adapter.contract.test.ts`

Follow the Stripe reference (`src/stripe/__tests__/adapter.contract.test.ts`):

```ts
import { runExternalConnectionContract, type AdapterVariant }
  from '../../connections/__tests__/contractHarness.js';

const liveVariant: AdapterVariant<GaConnection> = {
  name: 'LiveGaAdapter',
  build() {
    const sdk = makeGaSdkMock();
    return {
      adapter: new LiveGaAdapter(sdk),
      primeProbeOk: () => { /* stub the SDK call your probe() uses */ },
      cleanup: () => Promise.resolve(),
    };
  },
};

const mockVariant: AdapterVariant<GaConnection> = {
  name: 'MockGaAdapter',
  build() {
    return { adapter: new MockGaAdapter(), cleanup: () => Promise.resolve() };
  },
};

runExternalConnectionContract([liveVariant, mockVariant]);

// Then add GA-specific behavioral tests here (properties.list return shape, etc.)
```

The harness verifies the shared `ExternalConnection` invariants (`name` non-empty,
`mode()` returns 'live'/'mock', `probe()` returns a well-formed `ProbeResult`) so
you don't rewrite them per connection.

## 8. Adversarial checklist

Before shipping, exercise these failure modes with dedicated tests:

- **Rate-limit response** — LiveAdapter's error mapping classifies rate-limit vs
  other errors correctly (see `src/connections/probe.ts` for the regex the shared
  probe helper uses).
- **Orphan reference** — retrieve/update against an unknown ID returns a domain error,
  not an unhandled throw.
- **Idempotency dedup** — repeat mutations with the same key within the vendor's
  window (typically 24h) short-circuit and return the original result.
- **Seed guard** — MockAdapter refuses to overwrite persistent state without the
  test's explicit `RUN_INTEGRATION=1` flag (or your project's equivalent).

## 9. Boundary lint

Add your SDK import to the boundary lint so no code outside `src/<name>/*` reaches
into the raw SDK. Reference: `scripts/lint-stripe-boundary.mjs` — copy the pattern
and adjust the file glob + SDK package name. HUB-level services must call
`getConnection<GaConnection>('ga')`, not `import 'google-analytics'` directly.

## 10. Frontend indicator

The generic `<ConnectionStatus name="ga" />` component (S6) already handles indicator
+ mode-toggle rendering — no per-connection frontend code is needed. The Connections
admin panel at `/console/connections` lists every registered connection automatically.

If you want the indicator on a domain-specific page (e.g. Analytics dashboard header),
mount `<ConnectionStatus name="ga" label="Google Analytics" />` — the `label` prop
overrides the Title-Case fallback of `name`.

## Summary — the plug-in surface

Per connection you add:

| File | Purpose |
| --- | --- |
| `src/<name>/connection.ts` | `<Name>Connection extends ExternalConnection` |
| `src/<name>/schemas.ts` | Zod schemas for response shapes |
| `src/<name>/liveAdapter.ts` | Live implementation |
| `src/<name>/mockAdapter.ts` | Deterministic mock implementation |
| `src/<name>/registry.ts` | Bootstrap + `registerConnection` call |
| `db/migrations/NNN_*.sql` | (Optional) mock-schema tables |
| `src/<name>/__tests__/adapter.contract.test.ts` | Thin harness caller + domain tests |
| `scripts/lint-<name>-boundary.mjs` | Boundary guard |

Everything else — the settings-cache key, the admin API routes
(`/api/v1/admin/connections/:name/*`), the frontend indicator, the mode audit trail —
is handled by the framework. If you find yourself editing framework code to add your
connection, stop and route it back to a `connections` story.
