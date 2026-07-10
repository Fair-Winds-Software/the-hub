#!/usr/bin/env node
// Authorized by HUB-1589 (E-BE-1 S6, CR-2 R1 FIX#2) — Stripe SDK boundary CI gate.
// Authorized by HUB-1776 (S3 of HUB-1773) — extend allowed-boundary set to include
// src/stripe/liveAdapter.ts (the LiveStripeAdapter needs to import the SDK at runtime).
//
// Scans src/ for any `import ... from 'stripe'` or `require('stripe')` that is NOT a
// type-only import. Asserts that every runtime hit resolves to one of the whitelisted
// boundary files. Exits 1 on any violation; CI fails.
//
// Type-only imports (`import type Stripe from 'stripe'`) are intentionally allowed
// everywhere — they erase at runtime and cannot make Stripe SDK calls. The ESLint
// `no-restricted-imports` rule (eslint.config.js) catches these via static analysis;
// this script is a belt-and-suspenders gate that runs even if a developer disables the
// ESLint rule locally.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const ALLOWED_BOUNDARY_SET = new Set([
  'src/stripe/client.ts',
  'src/stripe/liveAdapter.ts',
]);

// Use git ls-files to enumerate tracked TypeScript files under src/ — fast + respects
// .gitignore. Falls back to a static enumeration if git is unavailable.
let files;
try {
  files = execSync('git ls-files src', { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
} catch (err) {
  console.error(`lint-stripe-boundary: failed to enumerate files via git (${err.message}).`);
  process.exit(2);
}

// Runtime import patterns:
//   import Stripe from 'stripe'
//   import { X } from 'stripe'
//   import * as stripe from 'stripe'
//   import 'stripe'              // side-effect
//   require('stripe')
// Type-only forms (NOT matched, intentionally):
//   import type Stripe from 'stripe'
//   import type { X } from 'stripe'
//   import { type X } from 'stripe'  // mixed — flagged conservatively as runtime
const RUNTIME_IMPORT_RE = /^\s*import\s+(?!type\b)[^'"]*?from\s+['"]stripe['"]|^\s*import\s+['"]stripe['"]|require\(['"]stripe['"]\)/;

const violations = [];
for (const relPath of files) {
  const normalized = relPath.replace(/\\/g, '/');
  if (ALLOWED_BOUNDARY_SET.has(normalized)) continue;

  let content;
  try {
    content = readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
  } catch {
    continue;
  }

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (RUNTIME_IMPORT_RE.test(line)) {
      violations.push({ file: normalized, line: i + 1, text: line.trim() });
    }
  }
}

const allowedList = [...ALLOWED_BOUNDARY_SET].join(', ');
if (violations.length > 0) {
  console.error(`lint-stripe-boundary ✗ ${violations.length} runtime Stripe SDK import(s) outside allowed boundary (${allowedList}):`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.text}`);
  }
  console.error('');
  console.error('Route the call through the StripeConnection interface (src/stripe/connection.ts) via the registry, or use `import type` if only the types are needed.');
  process.exit(1);
}

console.log(`lint-stripe-boundary ✓ all runtime Stripe imports resolve to allowed boundary (${allowedList})`);
