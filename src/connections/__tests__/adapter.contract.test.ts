// Authorized by HUB-1796 (S7 of HUB-1783) — parameterized aggregator/self-test for the
// ExternalConnection contract harness. Proves the harness itself works against a canonical
// in-memory dummy variant. Each real connection (Stripe today, GA next) invokes the
// same harness from its own adapter.contract.test.ts with its Live + Mock variants — see
// `docs/adding-a-connection.md` for the plug-in pattern.
//
// This file is intentionally NOT the place to run per-connection variants. It exists so:
//   1. The harness has documented coverage even if no connection is registered.
//   2. New authors have a copy-paste template that demonstrates the AdapterVariant shape.
import { describe, it, expect } from 'vitest';
import { runExternalConnectionContract, type AdapterVariant } from './contractHarness.js';
import type { ExternalConnection, ConnectionMode, ProbeResult } from '../base.js';

// ── Canonical in-memory ExternalConnection for the harness self-test ────────────

class DummyMockConnection implements ExternalConnection {
  readonly name = 'harness-self-test-mock';
  mode(): ConnectionMode {
    return 'mock';
  }
  async probe(): Promise<ProbeResult> {
    return { health: 'ok', latency_ms: 0 };
  }
}

class DummyLiveConnection implements ExternalConnection {
  readonly name = 'harness-self-test-live';
  mode(): ConnectionMode {
    return 'live';
  }
  async probe(): Promise<ProbeResult> {
    return { health: 'ok', latency_ms: 5 };
  }
}

const selfTestVariants: AdapterVariant[] = [
  {
    name: 'HarnessSelfTest — DummyLiveConnection',
    build() {
      return {
        adapter: new DummyLiveConnection(),
        cleanup: () => Promise.resolve(),
      };
    },
  },
  {
    name: 'HarnessSelfTest — DummyMockConnection',
    build() {
      return {
        adapter: new DummyMockConnection(),
        cleanup: () => Promise.resolve(),
      };
    },
  },
];

runExternalConnectionContract(selfTestVariants);

// Second describe verifies the type-level plug-in shape holds — a `variants: []`
// call must not throw, and future connections can extend the list without touching
// the harness itself.
describe('adapter contract harness — plug-in extensibility', () => {
  it('runExternalConnectionContract accepts an empty variants array without error', () => {
    expect(() => runExternalConnectionContract([])).not.toThrow();
  });
});
