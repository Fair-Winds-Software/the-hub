// Authorized by HUB-1702 — smoke test for the bundle-size CI guard (AC#6).
// Verifies the script exits 0 within budget and exits 1 when budget is forced low.
// Skips when dist/ is absent (local dev without a build) — CI always builds first.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const FRONTEND_ROOT = resolve(__dirname, '..', '..');
const SCRIPT = resolve(FRONTEND_ROOT, 'scripts', 'bundle-check.mjs');
const MANIFEST = resolve(FRONTEND_ROOT, 'dist', '.vite', 'manifest.json');
const distAvailable = existsSync(MANIFEST);

(distAvailable ? describe : describe.skip)('bundle-check (HUB-1702)', () => {
  it('exits 0 when the initial bundle is within the default budget', () => {
    const res = spawnSync('node', [SCRIPT], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('bundle-check ✓');
  });

  it('exits 1 when budget is forced below the actual bundle size', () => {
    const res = spawnSync('node', [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, BUNDLE_BUDGET_KB: '1' },
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('EXCEEDS 1 KB budget');
  });
});

(distAvailable ? describe.skip : describe)('bundle-check (HUB-1702) — pre-build state', () => {
  it.skip('skipped: dist/ unavailable; run `npm run build` to enable the smoke test', () => {
    // Placeholder so the describe block surfaces a skipped test name when no dist exists.
  });
});
