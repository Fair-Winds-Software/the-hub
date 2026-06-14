// Authorized by HUB-188 — POST /webhooks/stripe; HMAC signature verification; raw body preservation
import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { Readable } from 'stream';
import { getStripeClient } from '../stripe/client.js';
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
        const stripe = getStripeClient();
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

      // Verified — event routed to handler (FR-004 dispatch implemented in HUB-189)
      logger.info({ eventType: event.type, eventId: event.id }, 'Stripe webhook received');
      return reply.status(200).send({ received: true, type: event.type });
    },
  );
};

export default fp(stripeWebhookPlugin, { name: 'stripe-webhook' });
