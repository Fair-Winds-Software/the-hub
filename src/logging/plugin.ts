// Authorized by HUB-216 — traceparent Fastify plugin; W3C traceparent parsing; binds trace_id/span_id per request
import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

// W3C traceparent: version(2)-traceId(32)-parentId(16)-flags(2)
// Only version "00" is recognised per the spec.
const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

function parseTraceparent(
  raw: string | string[] | undefined,
): { trace_id: string | null; span_id: string | null } {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return { trace_id: null, span_id: null };
  const m = TRACEPARENT_RE.exec(value);
  if (!m) return { trace_id: null, span_id: null };
  return { trace_id: m[1], span_id: m[2] };
}

const traceparentPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRequest', async (request: FastifyRequest) => {
    const raw = request.headers['traceparent'];
    const { trace_id, span_id } = parseTraceparent(raw);

    // Rebind first so the warn entry also carries the new (null) trace_id
    request.log = request.log.child({ trace_id, span_id });

    if (raw && trace_id === null) {
      request.log.warn(
        { traceparent: Array.isArray(raw) ? raw[0] : raw },
        'invalid traceparent header — correlation fields set to null',
      );
    }
  });
};

export default fp(traceparentPlugin, { name: 'traceparent-plugin' });
