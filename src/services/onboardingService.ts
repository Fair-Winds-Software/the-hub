// Authorized by HUB-1818 (S1 of HUB-1787) — programmatic product registration primitive.
// Turns the one-off manual SQL described in HUB-1553 into a reusable service the S5
// wizard + the S4 prompt generator both consume.
//
// Flow (single PG transaction, one audit entry):
//   1. Validate slug shape (kebab-case) + uniqueness pre-check
//   2. INSERT products row (tenant scoped; product_type stored in metadata jsonb —
//      deferred column decision per HUB-1787 authoring callout)
//   3. Generate client_id (uuid) + client_secret (32 bytes base64url)
//   4. Bcrypt-hash the secret (cost 12 to match src/plugins/auth.ts DUMMY_HASH cost)
//   5. INSERT product_registrations row (natural key for HUB-98 OAuth2 client-credentials)
//   6. Write audit entry (`product.onboarding.register`)
//
// Response returns the plaintext client_secret ONE TIME. Caller must display it, offer
// a copy affordance, and warn the operator it cannot be retrieved again. Rotation lives
// in S2 (issues a new secret + revokes the old one).
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';
import { writeAuditEntry } from './auditLogService.js';

const BCRYPT_COST = 12;

// Kebab-case, 3–40 chars, starts with letter, no consecutive/trailing hyphens
const SLUG_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export interface RegisterProductInput {
  tenant_id: string;
  name: string;
  slug: string;
  /** Free-form for now — stored in metadata.product_type. See authoring callout #2. */
  product_type?: string;
  actor_operator_id: string;
  actor_ip?: string | null;
  actor_trace_id?: string | null;
}

export interface RegisterProductResult {
  product_id: string;
  slug: string;
  name: string;
  client_id: string;
  /** Plaintext — returned ONCE. Never persisted; only the bcrypt hash lives in PG. */
  client_secret: string;
}

function assertSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new AppError(400, 'slug must be kebab-case, 3+ chars, start with a letter');
  }
  if (slug.length < 3 || slug.length > 40) {
    throw new AppError(400, 'slug must be 3–40 chars');
  }
}

function assertName(name: string): void {
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 80) {
    throw new AppError(400, 'name must be 2–80 chars');
  }
}

function assertActor(id: string): void {
  if (typeof id !== 'string' || id.length === 0) {
    throw new AppError(400, 'actor_operator_id is required');
  }
}

/** 32 random bytes → 43-char base64url. High-entropy client_secret. */
function generateClientSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export async function registerProduct(input: RegisterProductInput): Promise<RegisterProductResult> {
  assertActor(input.actor_operator_id);
  assertName(input.name);
  assertSlug(input.slug);

  const pool = getPool();

  // Slug uniqueness pre-check for a clearer 409 than a raw 23505 SQLSTATE.
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM products WHERE slug = $1`,
    [input.slug],
  );
  if (existing.rows.length > 0) {
    throw new AppError(409, `slug '${input.slug}' is already registered`);
  }

  const clientSecret = generateClientSecret();
  const clientSecretHash = await bcrypt.hash(clientSecret, BCRYPT_COST);
  const clientId = crypto.randomUUID();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Product row. product_type intentionally stored in metadata jsonb rather than a
    // new column — the enum decision (callout #2 from the Epic authoring session) is
    // deferred until real usage clarifies the values needed.
    const { rows: prodRows } = await client.query<{ id: string }>(
      `INSERT INTO products (tenant_id, name, slug, active, metadata)
       VALUES ($1, $2, $3, true, $4::jsonb)
       RETURNING id::text`,
      [
        input.tenant_id,
        input.name.trim(),
        input.slug,
        JSON.stringify(input.product_type ? { product_type: input.product_type } : {}),
      ],
    );
    const productId = prodRows[0]!.id;

    await client.query(
      `INSERT INTO product_registrations (product_id, client_id, client_secret_hash)
       VALUES ($1, $2, $3)`,
      [productId, clientId, clientSecretHash],
    );

    await client.query('COMMIT');

    // Audit is outside the transaction — writeAuditEntry never throws, and we don't
    // want a Redis-outage audit failure to rollback a successful registration.
    await writeAuditEntry({
      tenant_id: input.tenant_id,
      product_id: productId,
      actor_id: input.actor_operator_id,
      actor_type: 'operator',
      operation: 'INSERT',
      table_name: 'products',
      record_id: productId,
      new_values: {
        action: 'product.onboarding.register',
        slug: input.slug,
        name: input.name.trim(),
        product_type: input.product_type ?? null,
        client_id: clientId,
      },
      ip_address: input.actor_ip ?? null,
      trace_id: input.actor_trace_id ?? null,
    });

    return {
      product_id: productId,
      slug: input.slug,
      name: input.name.trim(),
      client_id: clientId,
      client_secret: clientSecret,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
