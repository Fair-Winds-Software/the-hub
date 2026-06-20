// Authorized by HUB-1023 — POST /api/v1/compliance/signals; HMAC-verified signal ingestion; dedup via signal_id; burn-in gap tracking; rejection log
// Authorized by HUB-4.1 L2 — Red Team M3: use timingSafeEqual for HMAC comparison; Red Team L2: use createHash for content_hash
import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { Readable } from 'stream';
import { createDecipheriv, createHash, createHmac, randomBytes as _randomBytes, timingSafeEqual } from 'node:crypto';
import { getPool } from '../../db/pool.js';
import { AppError } from '../../errors/AppError.js';

const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

function getEncryptionKey(): Buffer {
  const hex = process.env.HOOK_ENCRYPTION_KEY;
  if (!hex) throw new AppError(500, 'Hook encryption key not configured');
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) throw new AppError(500, 'HOOK_ENCRYPTION_KEY must be a 64-character hex string');
  return key;
}

function decryptHmacSecret(ciphertext: string): string {
  const key = getEncryptionKey();
  try {
    const buf = Buffer.from(ciphertext, 'base64');
    const iv = buf.subarray(0, IV_BYTES);
    const authTag = buf.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
    const encrypted = buf.subarray(IV_BYTES + AUTH_TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    throw new AppError(500, 'HMAC secret decryption failed');
  }
}

function computeSignature(rawBody: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const complianceSignalPlugin: FastifyPluginAsync = async (fastify) => {
  const pool = getPool();

  // Scoped preParsing: captures raw body for HMAC verification before JSON parsing
  fastify.addHook(
    'preParsing',
    async (_request: FastifyRequest, _reply, payload): Promise<typeof payload> => {
      const chunks: Buffer[] = [];
      for await (const chunk of payload) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      }
      _request.rawBody = Buffer.concat(chunks);
      return Readable.from(_request.rawBody) as typeof payload;
    },
  );

  fastify.post(
    '/api/v1/compliance/signals',
    { config: { skipAuth: true } },
    async (request, reply) => {
      const raw = request.rawBody;
      const sigHeader = request.headers['x-hub-signature'];
      const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;

      // Helper to log rejection and return 202 (never 400 — prevents LaunchKit retry storms)
      async function reject(productId: string | null, reason: string): Promise<void> {
        try {
          await pool.query(
            `INSERT INTO compliance_signal_rejections (product_id, raw_payload, rejection_reason)
             VALUES ($1, $2, $3)`,
            [productId, request.body ?? null, reason],
          );
        } catch {
          // Rejection log write failure is non-fatal
        }
      }

      if (!raw || !sig || !sig.startsWith('sha256=')) {
        await reject(null, 'missing or malformed X-Hub-Signature header');
        return reply.status(202).send({ received: false });
      }

      const body = request.body as Record<string, unknown> | null;
      if (!body || typeof body !== 'object') {
        await reject(null, 'invalid JSON body');
        return reply.status(202).send({ received: false });
      }

      const productId = typeof body.product_id === 'string' ? body.product_id : null;
      if (!productId || !UUID_RE.test(productId)) {
        await reject(null, 'missing or invalid product_id');
        return reply.status(202).send({ received: false });
      }

      // Look up product compliance registration
      const { rows: regRows } = await pool.query<{
        hmac_secret_enc: string;
        burn_in_state: string;
      }>(
        `SELECT r.hmac_secret_enc, r.burn_in_state
         FROM compliance_product_registrations r
         WHERE r.product_id = $1 AND r.active = true`,
        [productId],
      );

      if (regRows.length === 0) {
        await reject(productId, 'product not registered for compliance');
        return reply.status(202).send({ received: false });
      }

      // Verify HMAC
      let decryptedSecret: string;
      try {
        decryptedSecret = decryptHmacSecret(regRows[0]!.hmac_secret_enc);
      } catch {
        await reject(productId, 'hmac_secret decryption failed');
        return reply.status(202).send({ received: false });
      }

      const expected = Buffer.from(`sha256=${computeSignature(raw, decryptedSecret)}`);
      const incoming = Buffer.from(sig);
      const sigValid = incoming.length === expected.length && timingSafeEqual(incoming, expected);
      if (!sigValid) {
        await reject(productId, 'signature mismatch');
        return reply.status(202).send({ received: false });
      }

      // Validate required signal fields
      const signalId = typeof body.signal_id === 'string' ? body.signal_id : null;
      const controlKey = typeof body.control_id === 'string' ? body.control_id : null;
      const signalType = typeof body.signal_type === 'string' ? body.signal_type : null;
      const observedAt = typeof body.observed_at === 'string' ? body.observed_at : null;

      if (!signalId || !controlKey || !signalType || !observedAt) {
        await reject(productId, 'missing required fields: signal_id, control_id, signal_type, observed_at');
        return reply.status(202).send({ received: false });
      }

      // Resolve control UUID from control_id text key
      const { rows: ctrlRows } = await pool.query<{ id: string }>(
        `SELECT id FROM compliance_controls WHERE control_id = $1 AND active = true`,
        [controlKey],
      );
      if (ctrlRows.length === 0) {
        await reject(productId, `unknown or inactive control: ${controlKey}`);
        return reply.status(202).send({ received: false });
      }
      const controlId = ctrlRows[0]!.id;

      // content_hash for tamper-evidence (hash of the full raw body)
      const contentHash = sha256Hex(raw.toString('utf8'));
      const isBurnInGap = regRows[0]!.burn_in_state === 'observe';

      // Insert — ON CONFLICT DO NOTHING handles dedup via (product_id, signal_id) unique constraint
      const { rowCount } = await pool.query(
        `INSERT INTO compliance_signal_evidence
           (product_id, control_id, signal_id, content_hash, payload, signal_type, observed_at, is_burn_in_gap)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (product_id, signal_id) DO NOTHING`,
        [
          productId,
          controlId,
          signalId,
          contentHash,
          JSON.stringify(body),
          signalType,
          new Date(observedAt),
          isBurnInGap,
        ],
      );

      const isDuplicate = (rowCount ?? 0) === 0;
      return reply.status(202).send({ received: true, duplicate: isDuplicate });
    },
  );
};

export default fp(complianceSignalPlugin, { name: 'compliance-signals' });
