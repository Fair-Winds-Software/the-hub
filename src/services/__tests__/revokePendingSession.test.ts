// Authorized by HUB-1695 (E-BE-1 S18) — unit tests for revokePendingSession:
//   - returns reason matrix (not_found / already_revoked / expired)
//   - happy path: revokes + writes ONE audit row with R1 detail
//   - guarded UPDATE race-safety: rowCount=0 → already_revoked + no audit
//   - idempotency: second call after success returns already_revoked + no audit
//   - actor=system (not the logged-out operator)
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPoolQuery = vi.hoisted(() => vi.fn());
vi.mock('../../db/pool.js', () => ({
  getPool: () => ({ query: mockPoolQuery }),
}));

const mockWriteAuditEntry = vi.hoisted(() => vi.fn());
vi.mock('../auditLogService.js', () => ({
  writeAuditEntry: mockWriteAuditEntry,
}));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { revokePendingSession } from '../operatorAuth.js';

const SESSION_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OPERATOR_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const FUTURE = new Date(Date.now() + 60 * 60 * 1000);
const PAST = new Date(Date.now() - 60 * 60 * 1000);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('revokePendingSession (HUB-1695)', () => {
  describe('reason matrix (no audit row)', () => {
    it('session not found → {revoked:false, reason:"not_found"}', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const result = await revokePendingSession(SESSION_ID);
      expect(result).toEqual({ revoked: false, reason: 'not_found' });
      expect(mockPoolQuery).toHaveBeenCalledTimes(1); // SELECT only — no UPDATE
      expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    });

    it('session already revoked → {revoked:false, reason:"already_revoked"}', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ operator_id: OPERATOR_ID, revoked: true, expires_at: FUTURE }],
      });

      const result = await revokePendingSession(SESSION_ID);
      expect(result).toEqual({ revoked: false, reason: 'already_revoked' });
      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
      expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    });

    it('refresh token expired → {revoked:false, reason:"expired"}', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ operator_id: OPERATOR_ID, revoked: false, expires_at: PAST }],
      });

      const result = await revokePendingSession(SESSION_ID);
      expect(result).toEqual({ revoked: false, reason: 'expired' });
      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
      expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    });
  });

  describe('happy path', () => {
    it('valid session → guarded UPDATE flips state + writes ONE audit row', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({
          rows: [{ operator_id: OPERATOR_ID, revoked: false, expires_at: FUTURE }],
        })
        .mockResolvedValueOnce({ rowCount: 1 });

      const result = await revokePendingSession(SESSION_ID, {
        ip: '203.0.113.7',
        trace_id: 'trace-abc',
      });

      expect(result).toEqual({ revoked: true });
      expect(mockPoolQuery).toHaveBeenCalledTimes(2);

      // Guarded UPDATE — must be the conditional form (race-safe).
      const [updateSql] = mockPoolQuery.mock.calls[1]!;
      expect(updateSql).toMatch(/UPDATE operator_refresh_tokens/);
      expect(updateSql).toMatch(/revoked\s*=\s*true/i);
      expect(updateSql).toMatch(/WHERE id = \$1 AND revoked = false/);

      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      const [entry] = mockWriteAuditEntry.mock.calls[0]!;
      expect(entry).toMatchObject({
        tenant_id: '00000000-0000-0000-0000-0000000000a1',
        actor_id: 'system:logout-retry',
        actor_type: 'system',
        operation: 'UPDATE',
        table_name: 'operator_refresh_tokens',
        record_id: SESSION_ID,
        event_type: 'auth.session.revoke_pending',
        ip_address: '203.0.113.7',
        trace_id: 'trace-abc',
      });
      expect(entry.new_values).toEqual({
        trigger: 'pending_revoke_retry',
        operator_id: OPERATOR_ID,
      });
    });

    it('audit context defaults to nulls when omitted', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({
          rows: [{ operator_id: OPERATOR_ID, revoked: false, expires_at: FUTURE }],
        })
        .mockResolvedValueOnce({ rowCount: 1 });

      await revokePendingSession(SESSION_ID);
      const [entry] = mockWriteAuditEntry.mock.calls[0]!;
      expect(entry.ip_address).toBeNull();
      expect(entry.trace_id).toBeNull();
    });
  });

  describe('guarded UPDATE race-safety', () => {
    it('rowCount=0 (another caller won the race) → already_revoked + no audit', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({
          rows: [{ operator_id: OPERATOR_ID, revoked: false, expires_at: FUTURE }],
        })
        .mockResolvedValueOnce({ rowCount: 0 }); // race lost — another worker flipped it first

      const result = await revokePendingSession(SESSION_ID);
      expect(result).toEqual({ revoked: false, reason: 'already_revoked' });
      expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    });
  });

  describe('idempotency contract (AC#4)', () => {
    it('two sequential calls → revoked then already_revoked, ONE audit row total', async () => {
      // Call 1: valid + UPDATE flips
      mockPoolQuery
        .mockResolvedValueOnce({
          rows: [{ operator_id: OPERATOR_ID, revoked: false, expires_at: FUTURE }],
        })
        .mockResolvedValueOnce({ rowCount: 1 });
      const r1 = await revokePendingSession(SESSION_ID);
      expect(r1).toEqual({ revoked: true });

      // Call 2: SELECT now returns revoked=true
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ operator_id: OPERATOR_ID, revoked: true, expires_at: FUTURE }],
      });
      const r2 = await revokePendingSession(SESSION_ID);
      expect(r2).toEqual({ revoked: false, reason: 'already_revoked' });

      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
    });
  });
});
