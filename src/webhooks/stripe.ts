// Authorized by HUB-188 — POST /webhooks/stripe; HMAC signature verification; raw body preservation
// Authorized by HUB-189 — idempotency enforcement; INSERT-on-conflict deduplication; status lifecycle
// Authorized by HUB-202 — event-type fan-out routing; DLQ fallback for null product_id
// Authorized by HUB-203 — pre-INSERT recognized-type gate; unrecognized events not stored
import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { Readable } from 'stream';
import { getStripeConnection } from '../stripe/registry.js';
import { getQueueForEventType, isRecognizedEventType, getDlqQueue } from '../queues/index.js';
import { getPool } from '../db/pool.js';
import logger from '../lib/logger.js';

// Augment FastifyRequest with rawBody captured before body parsing
declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

const stripeWebhookPlugin: FastifyPluginAsync = async (fastify) => {
  // Scoped preParsing hook — only fires for routes in this plugin scope
  // Reads the body stream into a Buffer, stores it on request.rawBody, returns a fresh Readable
  // so Fastify's JSON body parser still receives the payload for request.body population.
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
    '/webhooks/stripe',
    {
      // No preHandler — no JWT auth; HMAC signature is the sole auth mechanism
      // config.rateLimit: false — Stripe IPs are the origin; HMAC is the trust boundary
      config: { rateLimit: false },
    },
    async (request, reply) => {
      const sig = request.headers['stripe-signature'];
      const secret = process.env.STRIPE_WEBHOOK_SIGNING_SECRET!;

      if (!sig || !request.rawBody) {
        logger.warn({ failureReason: 'missing stripe-signature header' }, 'Stripe webhook rejected');
        return reply
          .status(400)
          .send({ error: { code: 400, message: 'Invalid signature' } });
      }

      let event;
      try {
        const stripe = getStripeConnection();
        event = stripe.webhooks.constructEvent(
          request.rawBody,
          Array.isArray(sig) ? sig[0] : sig,
          secret,
        );
      } catch (err) {
        logger.warn(
          { failureReason: (err as Error).message },
          'Stripe webhook signature verification failed',
        );
        return reply
          .status(400)
          .send({ error: { code: 400, message: 'Invalid signature' } });
      }

      // ── Recognized-type gate (HUB-203) — unrecognized types acknowledged without DB write ──
      // Set of recognized types is implicitly defined by registered queue factories (E10–E12).
      if (!isRecognizedEventType(event.type)) {
        logger.info({ event_id: event.id, event_type: event.type }, 'unrecognized event type — acknowledged without storing');
        return reply.status(200).send({ received: true, type: event.type });
      }

      // ── Idempotency: INSERT-on-conflict (no pre-check SELECT — eliminates TOCTOU race) ─────
      const pool = getPool();

      // Extract product_id from Stripe metadata (nullable — not an error if absent)
      // Double cast needed: Stripe's data.object is a wide union type with no index signature
      const dataObj = event.data.object as unknown as Record<string, unknown> | undefined;
      const productId =
        (dataObj?.metadata as Record<string, string> | undefined)?.product_id ?? null;

      const { rows: inserted } = await pool.query<{ id: string; received_at: Date }>(
        `INSERT INTO stripe_webhook_events (event_id, event_type, product_id, raw_event)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING id, received_at`,
        [event.id, event.type, productId, JSON.stringify(event)],
      );

      if (inserted.length === 0) {
        // Duplicate Stripe delivery — acknowledge without re-processing
        logger.info({ event_id: event.id }, 'duplicate event received');
        return reply.status(200).send({ received: true, type: event.type });
      }

      const { id: rowId, received_at: receivedAt } = inserted[0];

      // ── Route to event-type queue or DLQ (HUB-202) ────────────────────────────────────────
      // Event type is recognized at this point (pre-INSERT gate passed above).
      // Only remaining DLQ case: recognized type with null product_id.
      const useDlq = productId === null;
      if (useDlq) {
        logger.warn({ event_id: event.id, event_type: event.type }, 'product_id absent — routing to DLQ');
      }
      const queue = useDlq ? getDlqQueue() : getQueueForEventType(event.type);

      try {
        await queue.add('process-stripe-event', {
          event_id: event.id,
          event_type: event.type,
          product_id: productId,
          received_at: receivedAt.toISOString(),
        });

        await pool.query(
          `UPDATE stripe_webhook_events SET status = 'dispatched', processed_at = NOW() WHERE id = $1`,
          [rowId],
        );

        logger.info({ eventType: event.type, eventId: event.id }, 'Stripe webhook received');
      } catch (err) {
        // Enqueue failure: record status but still return 200 to prevent Stripe retry storm
        await pool
          .query(
            `UPDATE stripe_webhook_events SET status = 'failed', processed_at = NOW() WHERE id = $1`,
            [rowId],
          )
          .catch(() => {});

        logger.error({ eventType: event.type, eventId: event.id, err }, 'Stripe webhook dispatch failed');
      }

      return reply.status(200).send({ received: true, type: event.type });
    },
  );
};

export default fp(stripeWebhookPlugin, { name: 'stripe-webhook' });
