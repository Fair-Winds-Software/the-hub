// Authorized by HUB-49 — vitest configuration for HUB service
// Authorized by HUB-525 — setupFiles for LEASE_ENCRYPTION_KEY global env setup
// Authorized by HUB-4.1 L2 /test-consolidate — coverage thresholds as starting floor; see ADR-002
// Authorized by HUB-1570 — exclude frontend/ from backend Vitest run (frontend has its own Vitest config under frontend/vitest.config.ts; was introduced by HUB-1569)
// Authorized by HUB-1771 Phase 3 — `pool: 'forks'` runs each test file in its own child
// process so module-level singletons (pg pool, Redis client, Fastify plugins, Stripe SDK)
// cannot leak across files. Trade-off: ~50-100ms fork startup per file; total suite runtime
// grows from ~26s → ~40s. Acceptable for the elimination of an entire pollution class.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'frontend/**'],
    pool: 'forks',
    // HUB-1771 Phase 4: explicit isolation options so each test file runs in a
    // fresh child process. Default `isolate: true` was expected but observed to
    // leak module state (OPERATOR_JWT_SECRET among others) between billingAdmin
    // and other files under full-suite. Explicit + singleFork:false eliminates it.
    // HUB-1771 Phase 4: maxForks=1 serializes test files. Higher parallelism
    // triggered ioredis MaxRetriesPerRequestError under stress + parallel-fork
    // races on the shared hub_dev DB. Cost: full suite goes ~30s → ~100s.
    // Trade-off is worth it for zero-flake determinism.
    poolOptions: { forks: { isolate: true, singleFork: false, maxForks: 1, minForks: 1 } },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Starting floor — ratchet up after HUB-1543 is resolved and a measured baseline lands.
      // ADR-002 captures the YELLOW-accept rationale: thresholds are configured (skill invariant 8)
      // but values are not yet evidence-anchored to a measured run.
      thresholds: {
        statements: 70,
        branches: 60,
        functions: 70,
        lines: 70,
      },
    },
  },
});
