// Authorized by HUB-49 — vitest configuration for HUB service
// Authorized by HUB-525 — setupFiles for LEASE_ENCRYPTION_KEY global env setup
// Authorized by HUB-4.1 L2 /test-consolidate — coverage thresholds as starting floor; see ADR-002
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
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
