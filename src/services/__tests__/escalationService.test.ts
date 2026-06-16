// Authorized by HUB-788 — unit tests: runEscalationScan(); threshold check; idempotency; enqueue
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPoolQuery = vi.hoisted(() => vi.fn());
vi.mock('../../db/pool.js', () => ({
  getPool: () => ({ query: mockPoolQuery }),
}));

const mockQueueAdd = vi.hoisted(() => vi.fn());
const mockGetEscalationDeliverQueue = vi.hoisted(() => vi.fn());
vi.mock('../../queues/index.js', () => ({
  getEscalationDeliverQueue: mockGetEscalationDeliverQueue,
}));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runEscalationScan } from '../escalationService.js';

const TENANT_ID  = 'aaaaaaaa-0000-0000-0000-000000000001';
const PRODUCT_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const ALERT_ID   = 'cccccccc-0000-0000-0000-000000000003';
const RULE_ID    = 'dddddddd-0000-0000-0000-000000000004';
const EVENT_ID   = 'eeeeeeee-0000-0000-0000-000000000005';

const CONTACTS = [{ type: 'email', value: 'oncall@example.com' }];

beforeEach(() => {
  vi.resetAllMocks();
  mockGetEscalationDeliverQueue.mockReturnValue({ add: mockQueueAdd });
});

describe('runEscalationScan', () => {
  it('returns { scanned: 0, escalated: 0 } when no new alerts', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await runEscalationScan();
    expect(result).toEqual({ scanned: 0, escalated: 0 });
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });

  it('skips alert below threshold', async () => {
    const futureAlert = {
      id: ALERT_ID,
      product_id: PRODUCT_ID,
      alert_type: 'below_floor',
      first_fired_at: new Date(), // just now — below any threshold
      tenant_id: TENANT_ID,
    };
    const rule = { id: RULE_ID, tier: 1, threshold_minutes: 60, escalation_contacts: CONTACTS };
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [futureAlert] })      // alerts query
      .mockResolvedValueOnce({ rows: [rule] });             // rules query

    const result = await runEscalationScan();
    expect(result).toEqual({ scanned: 1, escalated: 0 });
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('fires escalation when threshold elapsed', async () => {
    const oldAlert = {
      id: ALERT_ID,
      product_id: PRODUCT_ID,
      alert_type: 'below_floor',
      first_fired_at: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours ago
      tenant_id: TENANT_ID,
    };
    const rule = { id: RULE_ID, tier: 1, threshold_minutes: 60, escalation_contacts: CONTACTS };
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [oldAlert] })
      .mockResolvedValueOnce({ rows: [rule] })
      .mockResolvedValueOnce({ rows: [{ id: EVENT_ID }] }); // idempotency INSERT RETURNING

    const result = await runEscalationScan();
    expect(result).toEqual({ scanned: 1, escalated: 1 });
    expect(mockQueueAdd).toHaveBeenCalledOnce();
  });

  it('enqueues job with correct data fields', async () => {
    const oldAlert = {
      id: ALERT_ID,
      product_id: PRODUCT_ID,
      alert_type: 'below_floor',
      first_fired_at: new Date(Date.now() - 120 * 60 * 1000),
      tenant_id: TENANT_ID,
    };
    const rule = { id: RULE_ID, tier: 2, threshold_minutes: 30, escalation_contacts: CONTACTS };
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [oldAlert] })
      .mockResolvedValueOnce({ rows: [rule] })
      .mockResolvedValueOnce({ rows: [{ id: EVENT_ID }] });

    await runEscalationScan();
    const [jobName, jobData] = mockQueueAdd.mock.calls[0]!;
    expect(jobName).toBe('escalation_deliver');
    expect(jobData).toMatchObject({
      alertEventId: ALERT_ID,
      tier: 2,
      contacts: CONTACTS,
      alertType: 'below_floor',
      tenantId: TENANT_ID,
      productId: PRODUCT_ID,
    });
  });

  it('skips escalation when idempotency row already exists (DO NOTHING returns null id)', async () => {
    const oldAlert = {
      id: ALERT_ID,
      product_id: PRODUCT_ID,
      alert_type: 'below_floor',
      first_fired_at: new Date(Date.now() - 120 * 60 * 1000),
      tenant_id: TENANT_ID,
    };
    const rule = { id: RULE_ID, tier: 1, threshold_minutes: 30, escalation_contacts: CONTACTS };
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [oldAlert] })
      .mockResolvedValueOnce({ rows: [rule] })
      .mockResolvedValueOnce({ rows: [] }); // ON CONFLICT DO NOTHING → no row returned

    const result = await runEscalationScan();
    expect(result).toEqual({ scanned: 1, escalated: 0 });
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('processes tier 1 and tier 2 independently for same alert', async () => {
    const oldAlert = {
      id: ALERT_ID,
      product_id: PRODUCT_ID,
      alert_type: 'below_floor',
      first_fired_at: new Date(Date.now() - 5 * 60 * 60 * 1000), // 5 hours ago
      tenant_id: TENANT_ID,
    };
    const tier1Rule = { id: RULE_ID, tier: 1, threshold_minutes: 60, escalation_contacts: CONTACTS };
    const tier2Rule = { id: 'rule-2', tier: 2, threshold_minutes: 120, escalation_contacts: CONTACTS };
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [oldAlert] })
      .mockResolvedValueOnce({ rows: [tier1Rule, tier2Rule] })
      .mockResolvedValueOnce({ rows: [{ id: EVENT_ID }] })     // tier 1 INSERT
      .mockResolvedValueOnce({ rows: [{ id: 'ev-2' }] });      // tier 2 INSERT

    const result = await runEscalationScan();
    expect(result).toEqual({ scanned: 1, escalated: 2 });
    expect(mockQueueAdd).toHaveBeenCalledTimes(2);
  });
});
