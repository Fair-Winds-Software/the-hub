// Authorized by HUB-1103 — registerProduct; client_id + client_secret generated; bcrypt hash D-008
// Authorized by HUB-1104 — listProducts, getProduct; client_secret_hash excluded at SQL level
// Authorized by HUB-1105 — rotateProductSecret; bcrypt computed outside transaction
import { randomBytes, randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';

export interface ProductRecord {
  product_id: string;
  client_id: string;
  name: string;
  active: boolean;
  created_at: string;
}

const BCRYPT_COST = 10;

function slugify(name: string, suffix: string): string {
  const base = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 80);
  return `${base}-${suffix}`;
}

export async function registerProduct(
  tenantId: string,
  name: string,
): Promise<ProductRecord & { client_secret: string }> {
  const pool = getPool();

  const { rows: tenantCheck } = await pool.query<{ active: boolean }>(
    `SELECT active FROM tenants WHERE id = $1`,
    [tenantId],
  );
  if (!tenantCheck[0]) throw new AppError(404, 'Tenant not found');
  if (!tenantCheck[0].active) throw new AppError(400, 'Tenant is inactive');

  const productId = randomUUID();
  const clientId = randomUUID();
  const clientSecret = randomBytes(32).toString('hex');
  const clientSecretHash = await bcrypt.hash(clientSecret, BCRYPT_COST);
  const slug = slugify(name, productId.slice(0, 8));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    try {
      await client.query(
        `INSERT INTO products (id, tenant_id, name, slug, active) VALUES ($1, $2, $3, $4, true)`,
        [productId, tenantId, name, slug],
      );
    } catch (err: unknown) {
      if ((err as { code?: string }).code === '23505') {
        await client.query('ROLLBACK');
        throw new AppError(409, 'Product name already in use for this tenant');
      }
      throw err;
    }

    await client.query(
      `INSERT INTO product_registrations (id, product_id, client_id, client_secret_hash)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), productId, clientId, clientSecretHash],
    );

    const { rows } = await client.query<{ name: string; active: boolean; created_at: string }>(
      `SELECT name, active, created_at FROM products WHERE id = $1`,
      [productId],
    );

    await client.query('COMMIT');
    return {
      product_id: productId,
      client_id: clientId,
      client_secret: clientSecret,
      name: rows[0]!.name,
      active: rows[0]!.active,
      created_at: rows[0]!.created_at,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function listProducts(
  tenantId: string,
  active?: boolean,
): Promise<ProductRecord[]> {
  const values: unknown[] = [tenantId];
  const activeClause = active !== undefined ? `AND p.active = $${values.push(active)}` : '';

  const { rows } = await getPool().query<ProductRecord>(
    `SELECT p.id AS product_id, pr.client_id, p.name, p.active, p.created_at
       FROM products p
       LEFT JOIN product_registrations pr ON pr.product_id = p.id
      WHERE p.tenant_id = $1 ${activeClause}
      ORDER BY p.created_at ASC`,
    values,
  );
  return rows;
}

export async function getProduct(productId: string, tenantId: string): Promise<ProductRecord> {
  const { rows } = await getPool().query<ProductRecord>(
    `SELECT p.id AS product_id, pr.client_id, p.name, p.active, p.created_at
       FROM products p
       LEFT JOIN product_registrations pr ON pr.product_id = p.id
      WHERE p.id = $1 AND p.tenant_id = $2`,
    [productId, tenantId],
  );
  if (!rows[0]) throw new AppError(404, 'Product not found');
  return rows[0];
}

export async function rotateProductSecret(
  productId: string,
  tenantId: string,
): Promise<{ client_secret: string; rotated_at: string }> {
  const pool = getPool();

  const { rows } = await pool.query<{ active: boolean }>(
    `SELECT p.active FROM products p WHERE p.id = $1 AND p.tenant_id = $2`,
    [productId, tenantId],
  );
  if (!rows[0]) throw new AppError(404, 'Product not found');
  if (!rows[0].active) throw new AppError(400, 'Cannot rotate credentials for inactive product');

  // bcrypt computed outside transaction to avoid holding DB connection during hash
  const newSecret = randomBytes(32).toString('hex');
  const newHash = await bcrypt.hash(newSecret, BCRYPT_COST);
  const rotatedAt = new Date().toISOString();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query(
      `UPDATE product_registrations SET client_secret_hash = $1 WHERE product_id = $2`,
      [newHash, productId],
    );
    if (!rowCount || rowCount === 0) {
      await client.query('ROLLBACK');
      throw new AppError(404, 'Product credentials not found');
    }
    await client.query('COMMIT');
    return { client_secret: newSecret, rotated_at: rotatedAt };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
