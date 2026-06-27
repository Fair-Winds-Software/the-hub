// Authorized by HUB-1697 (E-BE-1 S20) — unit tests for getAuditLog extension. Verifies SQL
// clause construction for the new actor / actions / entityTypes / from / to / sort args
// without touching the DB. Backward-compat test ensures tenant_id-only callers still produce
// the original WHERE shape.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPoolQuery = vi.hoisted(() => vi.fn());
vi.mock('../../db/pool.js', () => ({ getPool: () => ({ query: mockPoolQuery }) }));

import { getAuditLog } from '../operatorConsoleService.js';

const TENANT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PRODUCT = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

beforeEach(() => {
  vi.clearAllMocks();
  // Two queries per call: count, then row fetch. Default both to empty rows.
  mockPoolQuery
    .mockResolvedValueOnce({ rows: [{ count: '0' }] })
    .mockResolvedValueOnce({ rows: [] });
});

describe('getAuditLog (HUB-1697)', () => {
  it('backward compat: tenantId + productId-only produces the original WHERE shape', async () => {
    await getAuditLog({ tenantId: TENANT, productId: PRODUCT });
    const [countSql, countParams] = mockPoolQuery.mock.calls[0]!;
    expect(countSql).toMatch(/WHERE tenant_id = \$1 AND product_id = \$2/);
    expect(countSql).not.toMatch(/operator_id::text ILIKE/);
    expect(countSql).not.toMatch(/action = ANY/);
    expect(countParams).toEqual([TENANT, PRODUCT]);

    const [rowSql, rowParams] = mockPoolQuery.mock.calls[1]!;
    expect(rowSql).toMatch(/ORDER BY created_at DESC/);
    // Last two params are limit, offset
    expect(rowParams[rowParams.length - 2]).toBe(50);
    expect(rowParams[rowParams.length - 1]).toBe(0);
  });

  it('actor: ILIKE substring against operator_id::text (spec deviation #1)', async () => {
    await getAuditLog({ tenantId: TENANT, actor: 'deadbeef' });
    const [, params] = mockPoolQuery.mock.calls[0]!;
    expect(mockPoolQuery.mock.calls[0]![0]).toMatch(/operator_id::text ILIKE/);
    expect(params).toContain('%deadbeef%');
  });

  it('actions: IN list via ANY()', async () => {
    await getAuditLog({ tenantId: TENANT, actions: ['login', 'logout', 'revoke'] });
    const [sql, params] = mockPoolQuery.mock.calls[0]!;
    expect(sql).toMatch(/action = ANY\(\$\d+::text\[\]\)/);
    expect(params).toContainEqual(['login', 'logout', 'revoke']);
  });

  it('entityTypes: IN list via ANY()', async () => {
    await getAuditLog({ tenantId: TENANT, entityTypes: ['tenant', 'product'] });
    const [sql, params] = mockPoolQuery.mock.calls[0]!;
    expect(sql).toMatch(/entity_type = ANY\(\$\d+::text\[\]\)/);
    expect(params).toContainEqual(['tenant', 'product']);
  });

  it('from/to: created_at >= / <= bounds (AND across categories per AC#2)', async () => {
    const from = new Date('2026-05-01T00:00:00Z');
    const to = new Date('2026-05-31T23:59:59Z');
    await getAuditLog({ tenantId: TENANT, from, to });
    const [sql, params] = mockPoolQuery.mock.calls[0]!;
    expect(sql).toMatch(/created_at >= \$\d+/);
    expect(sql).toMatch(/created_at <= \$\d+/);
    expect(params).toContain(from);
    expect(params).toContain(to);
    // Each condition AND'd
    const andCount = (sql.match(/ AND /g) ?? []).length;
    expect(andCount).toBeGreaterThanOrEqual(2);
  });

  it('sort=asc emits ORDER BY created_at ASC', async () => {
    await getAuditLog({ tenantId: TENANT, sort: 'asc' });
    const [rowSql] = mockPoolQuery.mock.calls[1]!;
    expect(rowSql).toMatch(/ORDER BY created_at ASC/);
  });

  it('sort omitted defaults to ORDER BY created_at DESC', async () => {
    await getAuditLog({ tenantId: TENANT });
    const [rowSql] = mockPoolQuery.mock.calls[1]!;
    expect(rowSql).toMatch(/ORDER BY created_at DESC/);
  });

  it('all filters together: AND-intersected (multi-filter AC#2 semantics)', async () => {
    await getAuditLog({
      tenantId: TENANT,
      productId: PRODUCT,
      actor: 'op-x',
      actions: ['login'],
      entityTypes: ['tenant'],
      from: new Date('2026-05-01T00:00:00Z'),
      to: new Date('2026-05-31T23:59:59Z'),
    });
    const [sql] = mockPoolQuery.mock.calls[0]!;
    // Seven distinct filters → six " AND " separators
    const andCount = (sql.match(/ AND /g) ?? []).length;
    expect(andCount).toBe(6);
  });
});
