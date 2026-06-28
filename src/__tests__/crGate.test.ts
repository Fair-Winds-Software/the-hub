// Authorized by HUB-1696 (E-BE-1 S19) — FR-009 cross-CR integration test gate. Meta-test
// that pins (a) every HUB-1556 CR has at least one canonical test file checked into the
// repo, and (b) none of those files have silenced tests via .skip / .todo without an
// explicit allowlist entry in .cr-skip-overrides.json (operator-managed, git-tracked
// audit trail per spec AC#4).
//
// The gate executes LAST in HUB-1556 (per the story's Epic Build-Order Constraint). If
// any canonical file goes missing OR an unauthorized skip appears, this test fails with
// the exact filename + line number so the offender is immediately visible.
//
// Spec deviations (documented here, mirrored in PR description):
// 1. File paths under `src/__tests__/...` (HUB code root), not spec's `backend/__tests__/
//    integration/...`. HUB never adopted the `backend/` prefix.
// 2. CR→file mapping is flexible (1–3 files per CR) to reflect HUB's split-test style
//    (service-level + route-level + RUN_INTEGRATION-gated). Spec listed one file per CR
//    by name; the spirit (a green test gate per CR) is preserved.
// 3. CONTRIBUTING.md update (spec AC#4) — HUB has no CONTRIBUTING.md; convention is
//    documented inline in this file's header + the override file's _doc field. Adding a
//    top-level convention doc is a /harden Stage 4 follow-up.
// 4. HUB-1556 Epic AC update (spec AC#5) — using a Jira comment on HUB-1556 rather than
//    editing the Epic description directly (MCP editJiraIssue ADF quirk on >~1KB
//    payloads per memory note). Comment URL referenced in the PR description.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Canonical CR → test-file map (every HUB-1556 CR must appear here) ─────────
// Adding a new CR or rerouting one to a different canonical file requires the
// HUB-1556 Epic owner to update both this map AND the corresponding entry in the
// Epic's FR-009 satisfaction note.
const CR_TEST_FILES: Record<string, string[]> = {
  'CR-1 (Jira integration — HUB-1593/1594)': [
    'src/services/__tests__/jiraIntegrationService.test.ts',
  ],
  'CR-2 (billing_mode — HUB-1589/1590/1591)': [
    'src/__tests__/billingMode.integration.test.ts',
    'src/services/__tests__/createInternalInvoice.test.ts',
    'src/services/__tests__/updatePlanBillingMode.test.ts',
  ],
  'CR-3 (portfolio margin — HUB-1595/1596)': [
    'src/services/__tests__/getPortfolioMargin.test.ts',
    'src/routes/__tests__/analyticsRoutesPortfolioMargin.test.ts',
  ],
  'CR-4 (role rename — HUB-1587/1588)': [
    'src/__tests__/roleRename.integration.test.ts',
    'src/hooks/__tests__/operatorRbac.test.ts',
  ],
  'CR-5 (pricing scenario — HUB-1597/1598)': [
    'src/services/__tests__/computePricingScenario.test.ts',
    'src/routes/__tests__/analyticsRoutesPricingScenario.test.ts',
  ],
  'Cross-CR (HUB-1599 SOC 2 audit coverage)': [
    'src/__tests__/auditLogCoverageHub1556.test.ts',
  ],
};

const REPO_ROOT = process.cwd();
const OVERRIDES_PATH = resolve(REPO_ROOT, '.cr-skip-overrides.json');

// Regex matches `test.skip(`, `it.skip(`, `describe.skip(`, plus the `.todo` variants.
// Lookbehind avoids matching prose like ".not.skip" (none in HUB today, but defensive).
const SKIP_RE = /\b(?:test|it|describe)\.(skip|todo)\b/g;

interface Override {
  reason: string;
}

function loadOverrides(): Record<string, Override | string> {
  if (!existsSync(OVERRIDES_PATH)) return {};
  const raw = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8')) as Record<string, unknown>;
  const out: Record<string, Override | string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('_')) continue; // skip _doc / _format metadata
    out[key] = value as Override | string;
  }
  return out;
}

interface SkipFinding {
  file: string;
  line: number;
  kind: 'skip' | 'todo';
  snippet: string;
}

function scanFileForSkips(relPath: string): SkipFinding[] {
  const abs = resolve(REPO_ROOT, relPath);
  if (!existsSync(abs)) return [];
  const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
  const findings: SkipFinding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    SKIP_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SKIP_RE.exec(line)) !== null) {
      findings.push({
        file: relPath,
        line: i + 1,
        kind: m[1] as 'skip' | 'todo',
        snippet: line.trim().slice(0, 120),
      });
    }
  }
  return findings;
}

describe('HUB-1696 — CR Gate (FR-009 cross-CR integration test gate)', () => {
  it('all canonical CR test files exist on disk', () => {
    const missing: string[] = [];
    for (const [crLabel, files] of Object.entries(CR_TEST_FILES)) {
      for (const file of files) {
        if (!existsSync(resolve(REPO_ROOT, file))) {
          missing.push(`${crLabel}: ${file}`);
        }
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `HUB-1696 gate FAIL — ${missing.length} canonical CR test file(s) missing:\n  - ${missing.join('\n  - ')}\n` +
          `Each missing file means a HUB-1556 CR has no enforced test coverage. ` +
          `Author the missing file before HUB-1556 transitions to Done.`,
      );
    }
    expect(missing).toEqual([]);
  });

  it('no unauthorized .skip / .todo in canonical CR test files', () => {
    const overrides = loadOverrides();
    const allFiles = Object.values(CR_TEST_FILES).flat();
    const findings = allFiles.flatMap(scanFileForSkips);

    const unauthorized = findings.filter(
      (f) => overrides[`${f.file}:${f.line}`] === undefined,
    );

    if (unauthorized.length > 0) {
      const detail = unauthorized
        .map((f) => `  - ${f.file}:${f.line} — ${f.kind} — ${f.snippet}`)
        .join('\n');
      throw new Error(
        `HUB-1696 gate FAIL — ${unauthorized.length} unauthorized .skip/.todo found in CR test files:\n${detail}\n` +
          `If the skip is legitimate (e.g., RUN_INTEGRATION-gated harness), add an entry to .cr-skip-overrides.json ` +
          `with key "${unauthorized[0]!.file}:${unauthorized[0]!.line}" and a prose reason. The PR diff is the audit trail.`,
      );
    }
    expect(unauthorized).toEqual([]);
  });

  it('overrides file is well-formed JSON with string reasons (audit-trail integrity)', () => {
    expect(existsSync(OVERRIDES_PATH)).toBe(true);
    const raw = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8')) as Record<string, unknown>;

    // Every non-metadata entry must be a non-empty string. Empty / null reasons would
    // silently allow a skip with no audit signal, defeating spec AC#4's intent.
    const bad: string[] = [];
    for (const [key, value] of Object.entries(raw)) {
      if (key.startsWith('_')) continue;
      if (typeof value !== 'string' || value.trim().length === 0) {
        bad.push(`${key}: ${JSON.stringify(value)}`);
      }
    }
    if (bad.length > 0) {
      throw new Error(
        `HUB-1696 gate FAIL — overrides file has ${bad.length} entrie(s) with missing / non-string reasons:\n  - ${bad.join('\n  - ')}`,
      );
    }
    expect(bad).toEqual([]);
  });
});
