// Authorized by HUB-1796 (S7 of HUB-1783) — parameterized contract-test harness. Runs
// the shared ExternalConnection behavioral suite against any (Live, Mock) adapter pair
// supplied by a per-connection test file. New connection authors plug in by exporting
// an AdapterVariant per adapter and passing them to runExternalConnectionContract()
// from their own adapter.contract.test.ts.
//
// The harness verifies the invariants every ExternalConnection must satisfy:
//   1. `name` is a non-empty string identifier
//   2. `mode()` returns either 'live' or 'mock'
//   3. `probe()` resolves to a well-formed ProbeResult (health + non-negative latency_ms)
//
// Connection-specific behavioral tests (Stripe's balance.retrieve return shape, GA's
// properties.list, etc.) stay in the connection's own contract test file. This harness
// owns ONLY the shared ExternalConnection contract — anything domain-specific belongs
// to the caller.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ExternalConnection, ProbeResult } from '../base.js';

export interface AdapterVariant<T extends ExternalConnection = ExternalConnection> {
  /** Human-readable label used in vitest describe blocks (e.g. 'LiveStripeAdapter'). */
  name: string;
  build(): {
    adapter: T;
    /**
     * Optional hook: called before the probe test so live variants can stub SDK
     * responses that make .probe() resolve successfully.
     */
    primeProbeOk?: () => void;
    cleanup: () => Promise<void>;
  };
}

function isProbeResult(v: unknown): v is ProbeResult {
  if (v === null || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return (
    (p['health'] === 'ok' || p['health'] === 'degraded' || p['health'] === 'down') &&
    typeof p['latency_ms'] === 'number'
  );
}

/**
 * Runs the shared ExternalConnection contract suite against each supplied variant.
 * Call from a per-connection test file (`src/<name>/__tests__/adapter.contract.test.ts`)
 * with an array of Live + Mock variants for that connection.
 */
export function runExternalConnectionContract<T extends ExternalConnection>(
  variants: AdapterVariant<T>[],
): void {
  for (const variant of variants) {
    describe(`ExternalConnection contract: ${variant.name}`, () => {
      let ctx: ReturnType<AdapterVariant<T>['build']>;

      beforeAll(() => {
        ctx = variant.build();
      });

      afterAll(async () => {
        if (ctx) await ctx.cleanup();
      });

      it('name is a non-empty string', () => {
        expect(typeof ctx.adapter.name).toBe('string');
        expect(ctx.adapter.name.length).toBeGreaterThan(0);
      });

      it("mode() returns 'live' or 'mock'", () => {
        const m = ctx.adapter.mode();
        expect(m === 'live' || m === 'mock').toBe(true);
      });

      it('probe() resolves to a well-formed ProbeResult', async () => {
        ctx.primeProbeOk?.();
        const result = await ctx.adapter.probe();
        expect(isProbeResult(result)).toBe(true);
        expect(result.latency_ms).toBeGreaterThanOrEqual(0);
      });
    });
  }
}
