// Authorized by HUB-4.1 L2 — /test-consolidate artifact generator.
//
// Scans every *.test.ts under src/ and packages/ for `// Authorized by HUB-XXX —` header
// lines, builds the reverse index (story key → list of relative test file paths), and
// writes __tests__/STORY_KEY_INDEX.json at repo root. Idempotent; safe to re-run.
//
// Run from repo root: node scripts/generate-story-key-index.mjs
//
// This artifact is a first-class input to /uat-extract — without it the Trust Ladder
// Layer 3 binding rule (matrix row → covering test file) cannot be enforced.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const STORY_KEY_RE = /\bHUB-\d+(?:\.\d+)?\b/g;
const HEADER_SCAN_LINES = 30; // story-key authorization headers always live in the top of the file

function listTestFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listTestFiles(full, out);
    } else if (entry.isFile() && /\.test\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const files = [
  ...listTestFiles(path.join(repoRoot, 'src')),
  ...listTestFiles(path.join(repoRoot, 'packages')),
].sort();

const storyToFiles = new Map();
const filesWithoutKey = [];

for (const file of files) {
  const rel = path.relative(repoRoot, file).replace(/\\/g, '/');
  const head = fs.readFileSync(file, 'utf8').split('\n').slice(0, HEADER_SCAN_LINES).join('\n');
  const keys = new Set(head.match(STORY_KEY_RE) ?? []);
  if (keys.size === 0) {
    filesWithoutKey.push(rel);
    continue;
  }
  for (const key of keys) {
    if (!storyToFiles.has(key)) storyToFiles.set(key, []);
    storyToFiles.get(key).push(rel);
  }
}

// Sort keys numerically by trailing number so HUB-9 < HUB-100
const sortedKeys = [...storyToFiles.keys()].sort((a, b) => {
  const an = parseFloat(a.replace('HUB-', ''));
  const bn = parseFloat(b.replace('HUB-', ''));
  return an - bn;
});

const story_keys = {};
for (const key of sortedKeys) story_keys[key] = storyToFiles.get(key).sort();

// No `generated_at` field — would make every re-run produce a diff even when the test suite
// is unchanged, breaking skill invariant 10 (idempotent re-run). Regeneration history is
// tracked via git log on this JSON file instead.
const output = {
  generator: 'scripts/generate-story-key-index.mjs',
  test_file_count: files.length,
  story_key_count: sortedKeys.length,
  files_without_key: filesWithoutKey,
  story_keys,
};

const outDir = path.join(repoRoot, '__tests__');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'STORY_KEY_INDEX.json');
fs.writeFileSync(outFile, JSON.stringify(output, null, 2) + '\n');

console.log(`Wrote ${path.relative(repoRoot, outFile)}`);
console.log(`  test files scanned: ${files.length}`);
console.log(`  distinct story keys: ${sortedKeys.length}`);
if (filesWithoutKey.length > 0) {
  console.log(`  WARN: ${filesWithoutKey.length} file(s) without HUB-XXX key in first ${HEADER_SCAN_LINES} lines:`);
  for (const f of filesWithoutKey) console.log(`    - ${f}`);
  process.exit(1);
}
