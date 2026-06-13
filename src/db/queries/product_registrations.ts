// Authorized by HUB-50 — product_registrations query helpers; client_secret_hash never in list/get paths
import { Pool } from 'pg';

export interface ProductRegistrationRow {
  id: string;
  product_id: string;
  client_id: string;
  created_at: Date;
  delta_data: Record<string, unknown> | null;
}

// Explicit column list — client_secret_hash is intentionally absent.
const SAFE_COLUMNS = 'id, product_id, client_id, created_at, delta_data';

export async function getProductRegistrationByClientId(
  pool: Pool,
  clientId: string
): Promise<ProductRegistrationRow | null> {
  const { rows } = await pool.query<ProductRegistrationRow>(
    `SELECT ${SAFE_COLUMNS} FROM product_registrations WHERE client_id = $1`,
    [clientId]
  );
  return rows[0] ?? null;
}

export async function listProductRegistrationsByProductId(
  pool: Pool,
  productId: string
): Promise<ProductRegistrationRow[]> {
  const { rows } = await pool.query<ProductRegistrationRow>(
    `SELECT ${SAFE_COLUMNS} FROM product_registrations WHERE product_id = $1 ORDER BY created_at ASC`,
    [productId]
  );
  return rows;
}

// Dedicated hash-access path — the ONLY place client_secret_hash is ever SELECTed.
// Called exclusively by the credential verification flow; must never feed list/get endpoints.
// TODO: wire bcrypt.compare() in the story that implements client credential verification.
export async function getClientSecretHashForVerification(
  pool: Pool,
  clientId: string
): Promise<string | null> {
  const { rows } = await pool.query<{ client_secret_hash: string }>(
    `SELECT client_secret_hash FROM product_registrations WHERE client_id = $1`,
    [clientId]
  );
  return rows[0]?.client_secret_hash ?? null;
}
