// Authorized by HUB-4.1 L2 — unit tests: createTenant, listTenants, getTenant, updateTenant, deactivateTenant

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock setup ────────────────────────────────────────────────────────────────

const mockPoolQuery = vi.hoisted(() => vi.fn());
const mockClientQuery = vi.hoisted(() => vi.fn());
const mockClientRelease = vi.hoisted(() => vi.fn());
const mockPoolConnect = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ query: mockClientQuery, release: mockClientRelease }),
);

vi.mock('../../db/pool.js', () => ({
  getPool: () => ({ query: mockPoolQuery, connect: mockPoolConnect }),
}));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  createTenant,
  listTenants,
  getTenant,
  updateTenant,
  deactivateTenant,
} from '../tenants.js';

const TENANT_ROW = {
  id: 'tenant-uuid-1',
  name: 'Acme Corp',
  tenant_type: 'external' as const,
  active: true,
  created_at: '2025-01-01T00:00:00.000Z',
  updated_at: '2025-01-01T00:00:00.000Z',
};

beforeEach(() => vi.clearAllMocks());

// ── createTenant ──────────────────────────────────────────────────────────────

describe('createTenant()', () => {
  it('returns TenantRecord on successful insert', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [TENANT_ROW] });

    const result = await createTenant({ name: 'Acme Corp', tenant_type: 'external' });

    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO tenants'),
      ['Acme Corp', 'external'],
    );
    expect(result).toEqual(TENANT_ROW);
  });

  it('throws AppError(409) when tenant name already in use (pg 23505)', async () => {
    const pgUniqueError = Object.assign(new Error('unique violation'), { code: '23505' });
    mockPoolQuery.mockRejectedValueOnce(pgUniqueError);

    await expect(createTenant({ name: 'Duplicate', tenant_type: 'external' })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('re-throws non-unique DB errors', async () => {
    const dbError = Object.assign(new Error('connection reset'), { code: '08006' });
    mockPoolQuery.mockRejectedValueOnce(dbError);

    await expect(createTenant({ name: 'Acme', tenant_type: 'external' })).rejects.toThrow('connection reset');
  });
});

// ── listTenants ───────────────────────────────────────────────────────────────

describe('listTenants()', () => {
  it('returns all tenants with no filters', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [TENANT_ROW] });

    const result = await listTenants();

    const sql = mockPoolQuery.mock.calls[0]![0] as string;
    expect(sql).not.toContain('WHERE');
    expect(result).toEqual([TENANT_ROW]);
  });

  it('filters by active=true', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [TENANT_ROW] });

    await listTenants({ active: true });

    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining('active = $1'),
      [true],
    );
  });

  it('filters by tenant_type', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [TENANT_ROW] });

    await listTenants({ tenant_type: 'internal' });

    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining('tenant_type = $1'),
      ['internal'],
    );
  });

  it('filters by both active and tenant_type', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await listTenants({ active: false, tenant_type: 'external' });

    const [sql, values] = mockPoolQuery.mock.calls[0]! as [string, unknown[]];
    expect(sql).toContain('active = $1');
    expect(sql).toContain('tenant_type = $2');
    expect(values).toEqual([false, 'external']);
  });

  it('returns empty array when no tenants match', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    expect(await listTenants()).toEqual([]);
  });
});

// ── getTenant ─────────────────────────────────────────────────────────────────

describe('getTenant()', () => {
  it('returns TenantRecord when found', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [TENANT_ROW] });

    const result = await getTenant('tenant-uuid-1');

    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining('WHERE id = $1'),
      ['tenant-uuid-1'],
    );
    expect(result).toEqual(TENANT_ROW);
  });

  it('throws AppError(404) when not found', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await expect(getTenant('nonexistent')).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ── updateTenant ──────────────────────────────────────────────────────────────

describe('updateTenant()', () => {
  it('updates name and returns updated record', async () => {
    const updated = { ...TENANT_ROW, name: 'Acme Corp Updated' };
    mockPoolQuery.mockResolvedValueOnce({ rows: [updated] });

    const result = await updateTenant('tenant-uuid-1', { name: 'Acme Corp Updated' });

    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining('name = $1'),
      expect.arrayContaining(['Acme Corp Updated', 'tenant-uuid-1']),
    );
    expect(result.name).toBe('Acme Corp Updated');
  });

  it('updates active flag', async () => {
    const updated = { ...TENANT_ROW, active: false };
    mockPoolQuery.mockResolvedValueOnce({ rows: [updated] });

    const result = await updateTenant('tenant-uuid-1', { active: false });

    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining('active = $1'),
      expect.arrayContaining([false, 'tenant-uuid-1']),
    );
    expect(result.active).toBe(false);
  });

  it('throws AppError(400) when nothing to update', async () => {
    await expect(updateTenant('tenant-uuid-1', {})).rejects.toMatchObject({ statusCode: 400 });
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('throws AppError(404) when tenant not found', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await expect(updateTenant('nonexistent', { name: 'New' })).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ── deactivateTenant ──────────────────────────────────────────────────────────

describe('deactivateTenant()', () => {
  it('deactivates tenant and cascades to products in transaction', async () => {
    mockClientQuery
      .mockResolvedValueOnce(undefined)                              // BEGIN
      .mockResolvedValueOnce({ rows: [{ active: true }] })          // SELECT active check
      .mockResolvedValueOnce(undefined)                              // UPDATE tenants
      .mockResolvedValueOnce({ rowCount: 3 })                       // UPDATE products
      .mockResolvedValueOnce(undefined);                             // COMMIT

    const result = await deactivateTenant('tenant-uuid-1');

    expect(result).toEqual({ products_deactivated: 3 });
    expect(mockClientQuery).toHaveBeenCalledWith('BEGIN');
    expect(mockClientQuery).toHaveBeenCalledWith('COMMIT');
    expect(mockClientRelease).toHaveBeenCalled();
  });

  it('throws AppError(404) when tenant not found', async () => {
    mockClientQuery
      .mockResolvedValueOnce(undefined)             // BEGIN
      .mockResolvedValueOnce({ rows: [] })          // SELECT — no row
      .mockResolvedValueOnce(undefined);            // ROLLBACK

    await expect(deactivateTenant('nonexistent')).rejects.toMatchObject({ statusCode: 404 });
    expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClientRelease).toHaveBeenCalled();
  });

  it('throws AppError(400) when tenant already inactive', async () => {
    mockClientQuery
      .mockResolvedValueOnce(undefined)                       // BEGIN
      .mockResolvedValueOnce({ rows: [{ active: false }] })  // SELECT — already inactive
      .mockResolvedValueOnce(undefined);                      // ROLLBACK

    await expect(deactivateTenant('tenant-uuid-1')).rejects.toMatchObject({ statusCode: 400 });
    expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  it('rolls back on unexpected error and re-throws', async () => {
    const dbError = new Error('constraint violation');
    mockClientQuery
      .mockResolvedValueOnce(undefined)                        // BEGIN
      .mockResolvedValueOnce({ rows: [{ active: true }] })    // SELECT
      .mockRejectedValueOnce(dbError);                         // UPDATE fails

    await expect(deactivateTenant('tenant-uuid-1')).rejects.toThrow('constraint violation');
    expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClientRelease).toHaveBeenCalled();
  });
});
