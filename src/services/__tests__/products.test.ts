// Authorized by HUB-4.1 L2 — unit tests: registerProduct, listProducts, getProduct, rotateProductSecret

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

const mockBcryptHash = vi.hoisted(() => vi.fn().mockResolvedValue('hashed-secret'));
vi.mock('bcryptjs', () => ({
  default: { hash: mockBcryptHash, compare: vi.fn() },
}));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  registerProduct,
  listProducts,
  getProduct,
  rotateProductSecret,
} from '../products.js';

const PRODUCT_ROW = {
  product_id: 'prod-uuid-1',
  client_id: 'client-uuid-1',
  name: 'My Product',
  active: true,
  created_at: '2025-01-01T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockBcryptHash.mockResolvedValue('hashed-secret');
});

// ── registerProduct ───────────────────────────────────────────────────────────

describe('registerProduct()', () => {
  const setupHappyPath = () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ active: true }] }); // tenant check
    mockClientQuery
      .mockResolvedValueOnce(undefined)                                // BEGIN
      .mockResolvedValueOnce(undefined)                                // INSERT products
      .mockResolvedValueOnce(undefined)                                // INSERT product_registrations
      .mockResolvedValueOnce({ rows: [{ name: 'My Product', active: true, created_at: '2025-01-01T00:00:00.000Z' }] }) // SELECT product
      .mockResolvedValueOnce(undefined);                               // COMMIT
  };

  it('returns product record including one-time client_secret', async () => {
    setupHappyPath();

    const result = await registerProduct('tenant-uuid-1', 'My Product');

    expect(result).toMatchObject({
      name: 'My Product',
      active: true,
      client_id: expect.any(String),
      client_secret: expect.any(String),
    });
    expect(result.client_secret).toHaveLength(64); // 32 bytes hex
    expect(mockClientQuery).toHaveBeenCalledWith('COMMIT');
    expect(mockClientRelease).toHaveBeenCalled();
  });

  it('includes tenant_id in product insert', async () => {
    setupHappyPath();

    await registerProduct('tenant-uuid-1', 'My Product');

    const insertCall = mockClientQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && (sql as string).includes('INSERT INTO products'),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![1]).toContain('tenant-uuid-1');
  });

  it('throws AppError(404) when tenant not found', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await expect(registerProduct('nonexistent', 'Product')).rejects.toMatchObject({ statusCode: 404 });
    expect(mockPoolConnect).not.toHaveBeenCalled();
  });

  it('throws AppError(400) when tenant is inactive', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ active: false }] });

    await expect(registerProduct('inactive-tenant', 'Product')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('throws AppError(409) on duplicate product name for tenant (pg 23505)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ active: true }] });
    mockClientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockRejectedValueOnce(Object.assign(new Error('unique'), { code: '23505' }));

    await expect(registerProduct('tenant-uuid-1', 'Duplicate')).rejects.toMatchObject({ statusCode: 409 });
    expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClientRelease).toHaveBeenCalled();
  });

  it('rolls back and re-throws on non-unique DB errors', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ active: true }] });
    const dbError = new Error('disk full');
    mockClientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockRejectedValueOnce(dbError);

    await expect(registerProduct('tenant-uuid-1', 'Product')).rejects.toThrow('disk full');
    expect(mockClientRelease).toHaveBeenCalled();
  });
});

// ── listProducts ──────────────────────────────────────────────────────────────

describe('listProducts()', () => {
  it('returns all products for tenant', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [PRODUCT_ROW] });

    const result = await listProducts('tenant-uuid-1');

    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining('WHERE p.tenant_id = $1'),
      expect.arrayContaining(['tenant-uuid-1']),
    );
    expect(result).toEqual([PRODUCT_ROW]);
  });

  it('filters by active status when provided', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [PRODUCT_ROW] });

    await listProducts('tenant-uuid-1', true);

    const [sql, values] = mockPoolQuery.mock.calls[0]! as [string, unknown[]];
    expect(sql).toContain('p.active = $2');
    expect(values).toContain(true);
  });

  it('returns empty array when no products exist', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    expect(await listProducts('tenant-uuid-1')).toEqual([]);
  });
});

// ── getProduct ────────────────────────────────────────────────────────────────

describe('getProduct()', () => {
  it('returns product when found for tenant', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [PRODUCT_ROW] });

    const result = await getProduct('prod-uuid-1', 'tenant-uuid-1');

    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining('WHERE p.id = $1 AND p.tenant_id = $2'),
      ['prod-uuid-1', 'tenant-uuid-1'],
    );
    expect(result).toEqual(PRODUCT_ROW);
  });

  it('throws AppError(404) when product not found or wrong tenant', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await expect(getProduct('prod-uuid-1', 'wrong-tenant')).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ── rotateProductSecret ───────────────────────────────────────────────────────

describe('rotateProductSecret()', () => {
  it('returns new client_secret on success', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ active: true }] }); // SELECT product check
    mockClientQuery
      .mockResolvedValueOnce(undefined)         // BEGIN
      .mockResolvedValueOnce({ rowCount: 1 })   // UPDATE product_registrations
      .mockResolvedValueOnce(undefined);         // COMMIT

    const result = await rotateProductSecret('prod-uuid-1', 'tenant-uuid-1');

    expect(result.client_secret).toHaveLength(64);
    expect(result.rotated_at).toBeDefined();
    expect(mockClientQuery).toHaveBeenCalledWith('COMMIT');
    expect(mockClientRelease).toHaveBeenCalled();
  });

  it('throws AppError(404) when product not found or wrong tenant', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await expect(rotateProductSecret('nonexistent', 'tenant-uuid-1')).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(mockPoolConnect).not.toHaveBeenCalled();
  });

  it('throws AppError(400) when product is inactive', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ active: false }] });

    await expect(rotateProductSecret('prod-uuid-1', 'tenant-uuid-1')).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('throws AppError(404) when registration row missing (rowCount=0)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ active: true }] });
    mockClientQuery
      .mockResolvedValueOnce(undefined)         // BEGIN
      .mockResolvedValueOnce({ rowCount: 0 });  // UPDATE — no registration found

    await expect(rotateProductSecret('prod-uuid-1', 'tenant-uuid-1')).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClientRelease).toHaveBeenCalled();
  });

  it('rolls back and re-throws on DB error', async () => {
    const dbError = new Error('write failed');
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ active: true }] });
    mockClientQuery
      .mockResolvedValueOnce(undefined)        // BEGIN
      .mockRejectedValueOnce(dbError);         // UPDATE fails

    await expect(rotateProductSecret('prod-uuid-1', 'tenant-uuid-1')).rejects.toThrow('write failed');
    expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClientRelease).toHaveBeenCalled();
  });
});
