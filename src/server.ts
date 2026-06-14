// Authorized by HUB-77 — Fastify instance options (base)
// Authorized by HUB-78 — Pino logger options; genReqId→trace_id; pino-pretty dev-only
// Authorized by HUB-216 — resolveLogLevel() replaces hard-coded 'info' default; debug in non-production
import pino from 'pino';
import type { DestinationStream } from 'pino';
import type { FastifyServerOptions } from 'fastify';
import { resolveLogLevel } from './logging/index.js';

/** Pino options shared by production and test builds. */
function buildPinoOptions() {
  return {
    level: resolveLogLevel(),

    // Remove Pino's default `pid` and `hostname` so every log line contains
    // exactly: {level, time, trace_id, tenant_id, product_id, msg}
    base: null,

    // Credential redaction — last-ditch defence against accidental header/body leaks
    redact: {
      paths: [
        'req.headers.authorization',
        'body.client_secret',
        'body.password',
      ],
      censor: '[Redacted]',
    },

    // Minimal serialisers — no request body or response body ever logged
    serializers: {
      req: (req: { method: string; url: string; id: string }) => ({
        method: req.method,
        url: req.url,
        trace_id: req.id,
      }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
  };
}

/**
 * Returns Fastify server options evaluated at call-time so env vars
 * (LOG_LEVEL, NODE_ENV) are read on each buildApp() call.
 *
 * @param dest  Optional Pino destination stream. When provided a pre-wired
 *              Pino instance is used (test path). When absent, Fastify creates
 *              its own Pino instance writing to stdout (production path).
 *              pino-pretty transport is never combined with a custom dest.
 */
export function createServerOptions(dest?: DestinationStream): FastifyServerOptions {
  const pinoOpts = buildPinoOptions();

  // Fastify v5 rejects a pre-created Pino instance via `logger`; use
  // `loggerInstance` for the test path and plain options for production.
  const loggerConfig = dest
    ? // Test path: pre-create a Pino instance writing to the provided stream.
      // pino-pretty transport is incompatible with a custom stream and is never
      // active in tests (NODE_ENV !== 'development').
      { loggerInstance: pino(pinoOpts, dest) }
    : // Production path: pass options so Fastify creates the Pino instance.
      // pino-pretty transport is activated only in development.
      {
        logger: {
          ...pinoOpts,
          ...(process.env.NODE_ENV === 'development' && {
            transport: { target: 'pino-pretty' },
          }),
        },
      };

  return {
    // Request logging is handled by the Pino plugin (HUB-78) via onRequest /
    // onResponse hooks — not by Fastify's built-in request logging.
    disableRequestLogging: true,

    // Trace ID: UUID v4 per request; exposed as `trace_id` on every log line
    genReqId: () => crypto.randomUUID(),
    requestIdLogLabel: 'trace_id',

    ...loggerConfig,
  };
}
