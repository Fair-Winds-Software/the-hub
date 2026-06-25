// Authorized by HUB-1569 — Vitest config; jsdom environment + jest-dom matchers
// Authorized by HUB-1581 — exclude Playwright e2e tests under __tests__/e2e/ (run via `npm run e2e`)
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/__tests__/setup.ts'],
    css: false,
    exclude: ['**/node_modules/**', '**/dist/**', '__tests__/e2e/**'],
  },
});
