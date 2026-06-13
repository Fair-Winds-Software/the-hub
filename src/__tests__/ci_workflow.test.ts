// Authorized by HUB-71 — CI workflow YAML structure validation (HUB-76)
// Authorized by HUB-77 — Redis service assertions added
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const WORKFLOW_PATH = fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url));
const workflow = readFileSync(WORKFLOW_PATH, 'utf8');

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

  it('redis service uses redis:7-alpine image', () => {
    expect(workflow).toContain('image: redis:7-alpine');
  });

  it('REDIS_URL is set in CI env and not echoed', () => {
    expect(workflow).toContain('REDIS_URL:');
    expect(workflow).not.toMatch(/echo\s+.*REDIS_URL/i);
  });

  it('JWT_SECRET is set in CI env and not echoed', () => {
    expect(workflow).toContain('JWT_SECRET:');
    expect(workflow).not.toMatch(/echo\s+.*JWT_SECRET/i);
  });
});
