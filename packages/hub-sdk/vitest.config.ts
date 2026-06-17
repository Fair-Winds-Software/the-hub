// Authorized by HUB-914 — vitest configuration for @maverick-launch/hub-sdk test suite
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**'],
      thresholds: {
        lines: 90,
        branches: 90,
      },
    },
  },
});
