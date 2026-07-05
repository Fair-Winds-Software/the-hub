// Authorized by HUB-1385 (E-CMP-WAVE4 S2 sub-task HUB-1393) — emitGrcSignal unit tests.
// Verifies:
//   * Happy path INSERTs into compliance_signal_evidence with all 7 required columns.
//   * Missing product slug logs warn + returns {emitted:false, reason:'unknown_product'}
//     without throwing (so the primary record commit is not blocked).
//   * Missing control_id → {emitted:false, reason:'unknown_control'}.
//   * content_hash is a stable SHA-256 hex derived from entityId|signalType|observedAt.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PoolClient } from 'pg';

vi.mock('../../lib/logger.js', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { emitGrcSignal } from '../grcSignalService.js';

function makeClient(): { client: PoolClient; queries: Array<{ sql: string; params: unknown[] }> } {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (/FROM products WHERE slug/i.test(sql)) {
      return { rows: params[0] === 'known-product' ? [{ id: 'prod-uuid-1' }] : [] };
    }
    if (/FROM compliance_controls WHERE control_id/i.test(sql)) {
      return { rows: params[0] === 'known-control' ? [{ id: 'ctrl-uuid-1' }] : [] };
    }
    if (/INSERT INTO compliance_signal_evidence/i.test(sql)) {
      return { rows: [{ id: 'evidence-uuid-1' }] };
    }
    return { rows: [] };
  });
  return { client: { query } as unknown as PoolClient, queries };
}

const FIXED_TIME = new Date('2026-07-05T12:00:00Z');

beforeEach(() => vi.clearAllMocks());

describe('emitGrcSignal happy path', () => {
  it('resolves product+control UUIDs then INSERTs into compliance_signal_evidence', async () => {
    const { client, queries } = makeClient();
    const result = await emitGrcSignal(client, {
      productSlug: 'known-product',
      controlKey: 'known-control',
      signalType: 'device_compliance_attested',
      entityId: '00000000-0000-0000-0000-000000000abc',
      payload: { device_id: 'dev-1', compliance_type: 'mdm_enrollment' },
      observedAt: FIXED_TIME,
    });

    expect(result).toEqual({ emitted: true, signalEvidenceId: 'evidence-uuid-1' });
    expect(queries.map((q) => q.sql)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/FROM products WHERE slug/i),
        expect.stringMatching(/FROM compliance_controls WHERE control_id/i),
        expect.stringMatching(/INSERT INTO compliance_signal_evidence/i),
      ]),
    );

    const insert = queries.find((q) => /INSERT INTO compliance_signal_evidence/i.test(q.sql))!;
    // Params order: product_id, control_id, signal_id, content_hash, payload, signal_type, observed_at
    expect(insert.params[0]).toBe('prod-uuid-1');
    expect(insert.params[1]).toBe('ctrl-uuid-1');
    expect(insert.params[2]).toBe('00000000-0000-0000-0000-000000000abc');
    expect(insert.params[3]).toMatch(/^[0-9a-f]{64}$/);
    expect(insert.params[5]).toBe('device_compliance_attested');
    expect(insert.params[6]).toBe(FIXED_TIME.toISOString());
  });

  it('produces a stable content_hash for identical inputs (deterministic)', async () => {
    const { client: c1, queries: q1 } = makeClient();
    const { client: c2, queries: q2 } = makeClient();
    const input = {
      productSlug: 'known-product',
      controlKey: 'known-control',
      signalType: 'device_compliance_attested',
      entityId: '00000000-0000-0000-0000-000000000abc',
      payload: {},
      observedAt: FIXED_TIME,
    };
    await emitGrcSignal(c1, input);
    await emitGrcSignal(c2, input);
    const h1 = q1.find((q) => /compliance_signal_evidence/i.test(q.sql))!.params[3];
    const h2 = q2.find((q) => /compliance_signal_evidence/i.test(q.sql))!.params[3];
    expect(h1).toBe(h2);
  });
});

describe('emitGrcSignal skip paths (never throws — primary write must commit)', () => {
  it('returns unknown_product when the slug does not exist in products.slug', async () => {
    const { client, queries } = makeClient();
    const result = await emitGrcSignal(client, {
      productSlug: 'missing-product',
      controlKey: 'known-control',
      signalType: 'x',
      entityId: 'e',
      payload: {},
      observedAt: FIXED_TIME,
    });
    expect(result).toEqual({ emitted: false, reason: 'unknown_product' });
    expect(queries.some((q) => /INSERT INTO compliance_signal_evidence/i.test(q.sql))).toBe(false);
  });

  it('returns unknown_control when the control_id does not exist', async () => {
    const { client, queries } = makeClient();
    const result = await emitGrcSignal(client, {
      productSlug: 'known-product',
      controlKey: 'missing-control',
      signalType: 'x',
      entityId: 'e',
      payload: {},
      observedAt: FIXED_TIME,
    });
    expect(result).toEqual({ emitted: false, reason: 'unknown_control' });
    expect(queries.some((q) => /INSERT INTO compliance_signal_evidence/i.test(q.sql))).toBe(false);
  });
});
