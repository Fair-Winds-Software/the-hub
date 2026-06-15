// Authorized by HUB-49 — vitest configuration for HUB service
// Authorized by HUB-525 — setupFiles for LEASE_ENCRYPTION_KEY global env setup
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
    },
  },
});
