// Authorized by HUB-1781 (S8 of HUB-1773) — admin connections routes: mode toggle for
// external-app connections. Currently only Stripe; the connections concept is intentionally
// generic so future Plaid / other integrations register here too.
// Authorized by HUB-1782 (S9 of HUB-1773) — GET /status endpoint with health probe +
// 15s cache. Powers the frontend 3-state indicator.
//
// Endpoints (all inside adminRoutesPlugin's RBAC scope; require operator auth):
//   GET  /api/v1/admin/connections/stripe/mode    → current mode
//   PUT  /api/v1/admin/connections/stripe/mode    → flip mode
//   GET  /api/v1/admin/connections/stripe/status  → mode + health + latency
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import { getStripeConnection, getStripeMode, setStripeMode, type StripeMode } from '../../stripe/registry.js';

interface OperatorAuth {
  operator_id?: string;
  role?: string;
}

function operatorFromRequest(req: FastifyRequest): OperatorAuth {
  const op = (req as unknown as { operator?: OperatorAuth }).operator;
  return op ?? {};
}

// ── Health probe with 15s cache ─────────────────────────────────────────────────
// Cache key includes mode so a flip invalidates immediately.

type Health = 'ok' | 'degraded' | 'down';
interface StatusResult {
  mode: StripeMode;
  health: Health;
  reason?: string;
  checked_at: string;
  latency_ms: number;
}

const PROBE_TIMEOUT_MS = 3000;
const CACHE_TTL_MS = 15_000;
let _cache: { key: string; result: StatusResult; expiresAt: number } | null = null;

async function probeLiveHealth(): Promise<Omit<StatusResult, 'mode' | 'checked_at'>> {
  const start = Date.now();
  try {
    const probe = getStripeConnection().balance.retrieve();
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('probe timeout')), PROBE_TIMEOUT_MS),
    );
    await Promise.race([probe, timeout]);
    return { health: 'ok', latency_ms: Date.now() - start };
  } catch (err) {
    const message = (err as Error).message;
    // Rate-limit-like errors classify as degraded; everything else is down.
    const isRateLimit = /rate_limit|rate limit|429/i.test(message);
    return {
      health: isRateLimit ? 'degraded' : 'down',
      reason: message,
      latency_ms: Date.now() - start,
    };
  }
}

async function computeStatus(mode: StripeMode): Promise<StatusResult> {
  const checked_at = new Date().toISOString();
  if (mode === 'mock') {
    return { mode, health: 'ok', checked_at, latency_ms: 0 };
  }
  const probe = await probeLiveHealth();
  return { mode, checked_at, ...probe };
}

async function getCachedStatus(): Promise<StatusResult> {
  const mode = getStripeMode();
  const key = `mode:${mode}`;
  const now = Date.now();
  if (_cache && _cache.key === key && _cache.expiresAt > now) {
    return _cache.result;
  }
  const result = await computeStatus(mode);
  _cache = { key, result, expiresAt: now + CACHE_TTL_MS };
  return result;
}

/** Test hook — clears the probe cache. */
export function _resetStripeStatusCacheForTest(): void {
  _cache = null;
}

const adminConnectionsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/v1/admin/connections/stripe/mode', async (req) => {
    // Any authenticated operator can read the current mode.
    void req;
    return { mode: getStripeMode() };
  });

  fastify.get('/api/v1/admin/connections/stripe/status', async (req) => {
    void req;
    return getCachedStatus();
  });

  fastify.put<{ Body: { mode: string } }>(
    '/api/v1/admin/connections/stripe/mode',
    async (req, reply) => {
      const { mode } = req.body ?? {};
      if (mode !== 'live' && mode !== 'mock') {
        throw new AppError(400, "mode must be 'live' or 'mock'");
      }
      const op = operatorFromRequest(req);
      await setStripeMode(mode as StripeMode, {
        operator_id: op.operator_id ?? null,
        actor_type: 'operator',
      });
      return reply.status(200).send({ mode });
    },
  );
};

export default adminConnectionsRoutes;
