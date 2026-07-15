// Authorized by HUB-1818 (S1 of HUB-1787) — unit tests for registerProduct. PG pool is
// mocked; verifies input validation, transaction shape, secret generation, and audit
// wiring without touching a real DB.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockClient = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
}));
const mockPool = vi.hoisted(() => ({
  connect: vi.fn(async () => mockClient),
  query: vi.fn(),
}));
const mockWriteAuditEntry = vi.hoisted(() =>
  vi.fn(async (_e: Record<string, unknown>): Promise<void> => undefined),
);

vi.mock('../../db/pool.js', () => ({ getPool: () => mockPool }));
vi.mock('../auditLogService.js', () => ({ writeAuditEntry: mockWriteAuditEntry }));

const { registerProduct, rotateCredential, revokeProduct } = await import('../onboardingService.js');

const TENANT_A = '00000000-0000-4000-8000-00000000eeaa';
const PRODUCT_A = '00000000-0000-4000-8000-000000000aaa';

function primePool(opts: { existingSlug?: boolean } = {}): void {
  mockPool.query.mockImplementation(async () => ({
    rows: opts.existingSlug ? [{ id: PRODUCT_A }] : [],
  }));
  mockClient.query.mockImplementation(async (sql: unknown) => {
    const s = String(sql);
    if (s.startsWith('INSERT INTO products')) return { rows: [{ id: PRODUCT_A }] };
    if (s.startsWith('INSERT INTO product_registrations')) return { rows: [] };
    return { rows: [] };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('registerProduct — happy path', () => {
  it('returns the product row + plaintext client_secret + client_id', async () => {
    primePool();
    const result = await registerProduct({
      tenant_id: TENANT_A,
      name: 'ContentHelm',
      slug: 'contenthelm',
      product_type: 'saas',
      actor_operator_id: 'op-1',
    });
    expect(result.product_id).toBe(PRODUCT_A);
    expect(result.slug).toBe('contenthelm');
    expect(result.name).toBe('ContentHelm');
    // Client id looks like a uuid.
    expect(result.client_id).toMatch(/^[0-9a-f-]{36}$/);
    // 32 bytes → 43 chars base64url (no padding).
    expect(result.client_secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('runs BEGIN → INSERT products → INSERT product_registrations → COMMIT in order', async () => {
    primePool();
    await registerProduct({
      tenant_id: TENANT_A,
      name: 'ContentHelm',
      slug: 'contenthelm',
      actor_operator_id: 'op-1',
    });
    const sqls = mockClient.query.mock.calls.map((c) => String(c[0]));
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[1]).toMatch(/^INSERT INTO products/);
    expect(sqls[2]).toMatch(/^INSERT INTO product_registrations/);
    expect(sqls[3]).toBe('COMMIT');
  });

  it('stores product_type in metadata.product_type', async () => {
    primePool();
    await registerProduct({
      tenant_id: TENANT_A,
      name: 'Manifest',
      slug: 'manifest',
      product_type: 'internal_only',
      actor_operator_id: 'op-1',
    });
    const prodInsertCall = mockClient.query.mock.calls.find(
      (c) => String(c[0]).startsWith('INSERT INTO products'),
    );
    const params = prodInsertCall![1] as unknown[];
    expect(JSON.parse(params[3] as string)).toEqual({ product_type: 'internal_only' });
  });

  it('bcrypts the client_secret before inserting into product_registrations', async () => {
    primePool();
    const result = await registerProduct({
      tenant_id: TENANT_A,
      name: 'ContentHelm',
      slug: 'contenthelm',
      actor_operator_id: 'op-1',
    });
    const regInsertCall = mockClient.query.mock.calls.find(
      (c) => String(c[0]).startsWith('INSERT INTO product_registrations'),
    );
    const params = regInsertCall![1] as unknown[];
    const persistedHash = params[2] as string;
    // bcryptjs v3 uses $2b$ prefix at cost 12
    expect(persistedHash).toMatch(/^\$2[aby]\$12\$/);
    // hash must NOT be the plaintext
    expect(persistedHash).not.toBe(result.client_secret);
  });

  it('writes one audit_log entry with the register action + client_id', async () => {
    primePool();
    await registerProduct({
      tenant_id: TENANT_A,
      name: 'ContentHelm',
      slug: 'contenthelm',
      product_type: 'saas',
      actor_operator_id: 'op-1',
    });
    expect(mockWriteAuditEntry).toHaveBeenCalledOnce();
    const entry = mockWriteAuditEntry.mock.calls[0]![0] as {
      tenant_id: string;
      product_id: string;
      actor_id: string;
      new_values: { action: string; slug: string; client_id: string };
    };
    expect(entry.tenant_id).toBe(TENANT_A);
    expect(entry.product_id).toBe(PRODUCT_A);
    expect(entry.actor_id).toBe('op-1');
    expect(entry.new_values.action).toBe('product.onboarding.register');
    expect(entry.new_values.slug).toBe('contenthelm');
    expect(entry.new_values.client_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('registerProduct — validation failures', () => {
  it('rejects empty actor_operator_id', async () => {
    primePool();
    await expect(
      registerProduct({
        tenant_id: TENANT_A,
        name: 'x',
        slug: 'x',
        actor_operator_id: '',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects name shorter than 2 chars', async () => {
    primePool();
    await expect(
      registerProduct({
        tenant_id: TENANT_A,
        name: 'x',
        slug: 'valid-slug',
        actor_operator_id: 'op-1',
      }),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('name') });
  });

  it('rejects slug that is not kebab-case', async () => {
    primePool();
    await expect(
      registerProduct({
        tenant_id: TENANT_A,
        name: 'ContentHelm',
        slug: 'ContentHelm',
        actor_operator_id: 'op-1',
      }),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('kebab') });
  });

  it('rejects slug with trailing hyphen', async () => {
    primePool();
    await expect(
      registerProduct({
        tenant_id: TENANT_A,
        name: 'ContentHelm',
        slug: 'contenthelm-',
        actor_operator_id: 'op-1',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects slug shorter than 3 chars', async () => {
    primePool();
    await expect(
      registerProduct({
        tenant_id: TENANT_A,
        name: 'ContentHelm',
        slug: 'ab',
        actor_operator_id: 'op-1',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('registerProduct — slug uniqueness', () => {
  it('returns 409 when the slug is already registered', async () => {
    primePool({ existingSlug: true });
    await expect(
      registerProduct({
        tenant_id: TENANT_A,
        name: 'ContentHelm 2',
        slug: 'contenthelm',
        actor_operator_id: 'op-1',
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('already registered'),
    });
    // Should short-circuit before opening a transaction.
    expect(mockClient.query).not.toHaveBeenCalled();
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });
});

describe('registerProduct — transaction rollback', () => {
  it('rolls back on INSERT failure and does not write audit', async () => {
    primePool();
    mockClient.query.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (s.startsWith('INSERT INTO product_registrations')) throw new Error('db boom');
      if (s.startsWith('INSERT INTO products')) return { rows: [{ id: PRODUCT_A }] };
      return { rows: [] };
    });
    await expect(
      registerProduct({
        tenant_id: TENANT_A,
        name: 'ContentHelm',
        slug: 'contenthelm',
        actor_operator_id: 'op-1',
      }),
    ).rejects.toThrow('db boom');
    const sqls = mockClient.query.mock.calls.map((c) => String(c[0]));
    expect(sqls).toContain('ROLLBACK');
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });
});

// ── HUB-1819 (S2 of HUB-1787) — rotateCredential + revokeProduct ─────────────

function primeRotationPool(opts: {
  productExists?: boolean;
  registrationExists?: boolean;
  updateRowCount?: number;
} = {}): void {
  const productExists = opts.productExists ?? true;
  const registrationExists = opts.registrationExists ?? true;
  const updateRowCount = opts.updateRowCount ?? 1;
  mockPool.query.mockImplementation(async (sql: unknown) => {
    const s = String(sql);
    if (s.includes('FROM products p WHERE p.id')) {
      return {
        rows: productExists
          ? [{ id: PRODUCT_A, slug: 'contenthelm', tenant_id: TENANT_A }]
          : [],
      };
    }
    if (s.includes('FROM product_registrations WHERE product_id')) {
      return {
        rows: registrationExists
          ? [{ id: 'reg-1', client_id: '00000000-0000-4000-8000-000000000ccc' }]
          : [],
      };
    }
    if (s.startsWith('UPDATE product_registrations')) {
      return { rows: [], rowCount: updateRowCount };
    }
    return { rows: [], rowCount: 0 };
  });
}

describe('rotateCredential — happy path', () => {
  it('mints a new client_secret, replaces the hash, keeps client_id stable', async () => {
    primeRotationPool();
    const result = await rotateCredential({
      product_id: PRODUCT_A,
      actor_operator_id: 'op-1',
      reason: 'scheduled rotation',
    });
    expect(result.product_id).toBe(PRODUCT_A);
    expect(result.slug).toBe('contenthelm');
    expect(result.client_id).toBe('00000000-0000-4000-8000-000000000ccc');
    expect(result.client_secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Verify UPDATE fired with a bcrypt hash.
    const updateCall = mockPool.query.mock.calls.find(
      (c) => String(c[0]).startsWith('UPDATE product_registrations'),
    );
    const params = updateCall![1] as unknown[];
    expect(params[0]).toMatch(/^\$2[aby]\$12\$/);
  });

  it('writes a rotate_credential audit entry with client_id + reason', async () => {
    primeRotationPool();
    await rotateCredential({
      product_id: PRODUCT_A,
      actor_operator_id: 'op-1',
      reason: 'quarterly',
    });
    expect(mockWriteAuditEntry).toHaveBeenCalledOnce();
    const entry = mockWriteAuditEntry.mock.calls[0]![0] as {
      new_values: { action: string; client_id: string; reason: string };
    };
    expect(entry.new_values.action).toBe('product.onboarding.rotate_credential');
    expect(entry.new_values.reason).toBe('quarterly');
  });
});

describe('rotateCredential — failure paths', () => {
  it('404 when product_id does not exist', async () => {
    primeRotationPool({ productExists: false });
    await expect(
      rotateCredential({
        product_id: PRODUCT_A,
        actor_operator_id: 'op-1',
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it('404 when product exists but has no registration row', async () => {
    primeRotationPool({ registrationExists: false });
    await expect(
      rotateCredential({
        product_id: PRODUCT_A,
        actor_operator_id: 'op-1',
      }),
    ).rejects.toMatchObject({
      statusCode: 404,
      message: expect.stringContaining('no registration'),
    });
  });

  it('400 when actor_operator_id is empty', async () => {
    primeRotationPool();
    await expect(
      rotateCredential({ product_id: PRODUCT_A, actor_operator_id: '' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('revokeProduct — happy path', () => {
  it('flips products.active=false, returns hard-revoke deadline, audits', async () => {
    mockPool.query.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (s.startsWith('UPDATE products SET active = false')) {
        return {
          rows: [{ id: PRODUCT_A, slug: 'contenthelm', tenant_id: TENANT_A, active: false }],
        };
      }
      return { rows: [] };
    });
    const result = await revokeProduct({
      product_id: PRODUCT_A,
      actor_operator_id: 'op-1',
      reason: 'billing lapse',
    });
    expect(result.product_id).toBe(PRODUCT_A);
    expect(result.slug).toBe('contenthelm');
    expect(result.active).toBe(false);
    expect(result.effective_hard_revoke_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(mockWriteAuditEntry).toHaveBeenCalledOnce();
    const entry = mockWriteAuditEntry.mock.calls[0]![0] as {
      new_values: { action: string; reason: string; effective_hard_revoke_at: string };
    };
    expect(entry.new_values.action).toBe('product.onboarding.revoke');
    expect(entry.new_values.reason).toBe('billing lapse');
  });

  it('respects JWT_EXPIRES_IN env var when computing hard_revoke_at', async () => {
    mockPool.query.mockImplementation(async () => ({
      rows: [{ id: PRODUCT_A, slug: 'x', tenant_id: TENANT_A, active: false }],
    }));
    process.env['JWT_EXPIRES_IN'] = '60';
    const before = Date.now();
    const result = await revokeProduct({
      product_id: PRODUCT_A,
      actor_operator_id: 'op-1',
    });
    const deadline = new Date(result.effective_hard_revoke_at).getTime();
    expect(deadline - before).toBeGreaterThanOrEqual(59 * 1000);
    expect(deadline - before).toBeLessThan(120 * 1000);
    delete process.env['JWT_EXPIRES_IN'];
  });
});

describe('revokeProduct — failure paths', () => {
  it('404 when product does not exist', async () => {
    mockPool.query.mockImplementation(async () => ({ rows: [] }));
    await expect(
      revokeProduct({ product_id: PRODUCT_A, actor_operator_id: 'op-1' }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('400 when actor_operator_id is empty', async () => {
    await expect(
      revokeProduct({ product_id: PRODUCT_A, actor_operator_id: '' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
