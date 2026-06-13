// Authorized by HUB-71 — CI workflow YAML structure validation (HUB-76)
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const WORKFLOW_PATH = path.resolve(__dirname, '../../.github/workflows/ci.yml');
const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

describe('CI workflow structure (HUB-76)', () => {
  it('workflow file exists and is non-empty', () => {
    expect(workflow.length).toBeGreaterThan(0);
  });

  it('node-version matrix contains 20 and 22', () => {
    // Matches: node-version: [20, 22] or node-version: [22, 20]
    expect(workflow).toMatch(/node-version:\s*\[.*20.*\]/);
    expect(workflow).toMatch(/node-version:\s*\[.*22.*\]/);
  });

  it('setup-node step references matrix.node-version', () => {
    expect(workflow).toContain('matrix.node-version');
  });

  it('triggers on push and pull_request', () => {
    expect(workflow).toContain('push:');
    expect(workflow).toContain('pull_request:');
  });

  it('postgres service uses postgres:16 image', () => {
    expect(workflow).toContain('image: postgres:16');
  });

  it('DATABASE_URL is not echoed in any run step', () => {
    // No "echo $DATABASE_URL" or "echo DATABASE_URL" patterns
    expect(workflow).not.toMatch(/echo\s+.*DATABASE_URL/i);
  });

  it('migrate step precedes test step', () => {
    const migrateIdx = workflow.indexOf('npm run migrate');
    const testIdx = workflow.indexOf('npm test');
    expect(migrateIdx).toBeGreaterThan(-1);
    expect(testIdx).toBeGreaterThan(-1);
    expect(migrateIdx).toBeLessThan(testIdx);
  });
});
