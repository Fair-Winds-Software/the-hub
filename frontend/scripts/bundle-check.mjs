#!/usr/bin/env node
// Authorized by HUB-1702 — CI bundle-size regression guard (HUB-1569 AC#3 durability).
// Sums gzipped sizes of every entry chunk + its sync imports + CSS as defined by vite's
// build manifest, then compares the total to BUNDLE_BUDGET_KB (default 250 KB). Lazy
// chunks (route-level imports) are NOT counted — they don't ship in the initial payload.
//
// Exit codes:
//   0 — within budget
//   1 — over budget (CI fails)
//   2 — manifest missing or malformed (run `npm run build` first)
import { readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, '..', 'dist');
const MANIFEST = join(DIST, '.vite', 'manifest.json');
const BUDGET_KB = parseInt(process.env.BUNDLE_BUDGET_KB ?? '250', 10);

if (!existsSync(MANIFEST)) {
  console.error(`bundle-check: manifest not found at ${MANIFEST}. Run 'npm run build' first.`);
  process.exit(2);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
} catch (err) {
  console.error(`bundle-check: failed to parse manifest: ${err.message}`);
  process.exit(2);
}

function gzippedSize(relPath) {
  const full = join(DIST, relPath);
  return gzipSync(readFileSync(full)).length;
}

// Walk entry + sync imports recursively. Lazy chunks live in `dynamicImports` — skipped.
const initialFiles = new Set();
const visited = new Set();
function collectFromKey(key) {
  if (visited.has(key)) return;
  visited.add(key);
  const entry = manifest[key];
  if (!entry) return;
  if (entry.file) initialFiles.add(entry.file);
  if (Array.isArray(entry.css)) entry.css.forEach((c) => initialFiles.add(c));
  if (Array.isArray(entry.imports)) entry.imports.forEach((i) => collectFromKey(i));
  // entry.dynamicImports intentionally NOT followed — those are lazy.
}

const entryKeys = Object.entries(manifest)
  .filter(([, v]) => v.isEntry)
  .map(([k]) => k);

if (entryKeys.length === 0) {
  console.error('bundle-check: no entries found in manifest. Aborting.');
  process.exit(2);
}

entryKeys.forEach(collectFromKey);

const sizes = [...initialFiles].map((f) => ({ file: f, gzip: gzippedSize(f) }));
const totalBytes = sizes.reduce((acc, s) => acc + s.gzip, 0);
const totalKb = totalBytes / 1024;
const headroom = BUDGET_KB - totalKb;
const ok = totalKb <= BUDGET_KB;

sizes.sort((a, b) => b.gzip - a.gzip);

if (ok) {
  console.log(
    `bundle-check ✓ initial gzipped: ${totalKb.toFixed(2)} KB / ${BUDGET_KB} KB budget (${headroom.toFixed(2)} KB headroom)`,
  );
  if (process.env.VERBOSE) {
    sizes.forEach((s) => console.log(`  ${(s.gzip / 1024).toFixed(2).padStart(8)} KB  ${s.file}`));
  }
  process.exit(0);
}

console.error(
  `bundle-check ✗ initial gzipped: ${totalKb.toFixed(2)} KB EXCEEDS ${BUDGET_KB} KB budget by ${(-headroom).toFixed(2)} KB`,
);
console.error('Offending chunks (largest first):');
sizes.forEach((s) => console.error(`  ${(s.gzip / 1024).toFixed(2).padStart(8)} KB  ${s.file}`));
process.exit(1);
