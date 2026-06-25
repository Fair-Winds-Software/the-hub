// Authorized by HUB-1581 — Lighthouse CI config for AC#2 (LCP/CLS/TBT/A11y thresholds).
//
// Routes audited at v0.1:
//   - /console/login  — the cold-load entry point for unauthenticated visitors. This is
//                       what real users hit first; the realistic CWV measurement target.
//
// Routes deferred:
//   - /console/dashboard — requires an authenticated session in the Zustand in-memory
//     store. Lighthouse's audit page runs in its own JS context with its own empty store,
//     so a pre-audit puppeteerScript that mocks /login on a different page cannot transfer
//     the session. Without a real BE in the audit pipeline, any dashboard measurement
//     would actually measure the redirect-to-login (auth guard kicks in). Logged as
//     D-HUB-SCOPE-051. Real dashboard CWV measurement is HUB-1562's DoD per R1 D-HUB-SCOPE-027.
//
// Targets (preset: desktop): LCP ≤ 2.5s, CLS ≤ 0.1, TBT ≤ 200ms, A11y score ≥ 0.95.

const PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}`;

module.exports = {
  ci: {
    collect: {
      url: [`${BASE}/console/login`],
      startServerCommand: `npx vite preview --port ${PORT} --strictPort --host 127.0.0.1`,
      startServerReadyPattern: 'Local',
      startServerReadyTimeout: 60000,
      numberOfRuns: 3,
      settings: {
        preset: 'desktop',
      },
    },
    assert: {
      assertions: {
        'largest-contentful-paint': ['error', { maxNumericValue: 2500 }],
        'cumulative-layout-shift': ['error', { maxNumericValue: 0.1 }],
        'total-blocking-time': ['error', { maxNumericValue: 200 }],
        'categories:accessibility': ['error', { minScore: 0.95 }],
      },
    },
    upload: {
      target: 'temporary-public-storage',
    },
  },
};
