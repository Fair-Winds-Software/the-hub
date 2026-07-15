// Authorized by HUB-1781 (S8 of HUB-1773) — admin connections routes: mode toggle for
// external-app connections. Currently only Stripe; the connections concept is intentionally
// generic so future Plaid / other integrations register here too.
// Authorized by HUB-1782 (S9 of HUB-1773) — GET /status endpoint with health probe +
// 15s cache. Powers the frontend 3-state indicator.
// Authorized by HUB-1793 (S4 of HUB-1783) — generic /connections/:name/* routes replacing
// the Stripe-specific paths. Delegates health probe + cache to the shared helper from
// HUB-1792. Backward-compat /connections/stripe/* aliases preserved for one release
// (TO REMOVE after frontend cutover in HUB-1795).
//
// Endpoints (all inside adminRoutesPlugin's RBAC scope; require operator auth):
//   GET  /api/v1/admin/connections                     → list all registered
//   GET  /api/v1/admin/connections/:name/mode          → current mode
//   PUT  /api/v1/admin/connections/:name/mode          → flip mode
//   GET  /api/v1/admin/connections/:name/status        → mode + health + latency
//
// Aliases (TO REMOVE after HUB-1795):
//   GET  /api/v1/admin/connections/stripe/mode         → GET  /connections/stripe/mode
//   PUT  /api/v1/admin/connections/stripe/mode         → PUT  /connections/stripe/mode
//   GET  /api/v1/admin/connections/stripe/status       → GET  /connections/stripe/status
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import {
  getConnection,
  getConnectionMode,
  listConnections,
  setConnectionMode,
} from '../../connections/registry.js';
import { getCachedStatus, runProbe, _resetStatusCacheForTest } from '../../connections/probe.js';
import type { ConnectionMode, ConnectionStatus, ExternalConnection } from '../../connections/base.js';
import { getStripeMode, setStripeMode, type StripeMode } from '../../stripe/registry.js';

interface OperatorAuth {
  operator_id?: string;
  role?: string;
}

function operatorFromRequest(req: FastifyRequest): OperatorAuth {
  const op = (req as unknown as { operatorUser?: OperatorAuth }).operatorUser;
  return op ?? {};
}

// ── Compute status for a named connection ───────────────────────────────────────

async function computeConnectionStatus(name: string): Promise<ConnectionStatus> {
  const mode = getConnectionMode(name);
  const checked_at = new Date().toISOString();
  if (mode === 'mock') {
    return { name, mode, health: 'ok', checked_at, latency_ms: 0 };
  }
  // Live mode: ask the connection to probe itself. The connection's .probe() method
  // encapsulates the "what does 'healthy' mean" logic (Stripe hits balance.retrieve;
  // GA hits properties.list; etc.).
  const adapter = getConnection<ExternalConnection>(name);
  const probe = await runProbe(name, () => adapter.probe().then(() => undefined));
  return { name, mode, checked_at, health: probe.health, reason: probe.reason, latency_ms: probe.latency_ms };
}

// ── Backward-compat /stripe/* alias state ──────────────────────────────────────
// The aliases run the S8/S9 Stripe-specific code path unchanged (they read via
// getStripeMode, not the generic registry). This preserves HUB-1782's exact behavior
// AND keeps the S9 unit tests passing without modification. Once Stripe migrates to the
// generic base in S5 (HUB-1794) the aliases can either delegate to the generic handlers
// OR be removed altogether after HUB-1795 frontend cutover.

type StripeStatusResult = {
  mode: StripeMode;
  health: 'ok' | 'degraded' | 'down';
  reason?: string;
  checked_at: string;
  latency_ms: number;
};

const STRIPE_ALIAS_CACHE_TTL_MS = 15_000;
const STRIPE_ALIAS_PROBE_TIMEOUT_MS = 3_000;
let _stripeAliasCache: { key: string; result: StripeStatusResult; expiresAt: number } | null = null;

/** Backward-compat test hook. Clears the /stripe/* alias's local status cache. */
export function _resetStripeStatusCacheForTest(): void {
  _stripeAliasCache = null;
  _resetStatusCacheForTest('stripe');
}

const adminConnectionsRoutes: FastifyPluginAsync = async (fastify) => {
  // ── Generic multi-connection routes ────────────────────────────────────────
  fastify.get('/api/v1/admin/connections', async (req) => {
    void req;
    return { connections: listConnections() };
  });

  fastify.get<{ Params: { name: string } }>(
    '/api/v1/admin/connections/:name/mode',
    async (req) => {
      const { name } = req.params;
      return { mode: getConnectionMode(name) };
    },
  );

  fastify.get<{ Params: { name: string } }>(
    '/api/v1/admin/connections/:name/status',
    async (req) => {
      const { name } = req.params;
      return getCachedStatus(name, () => computeConnectionStatus(name));
    },
  );

  fastify.put<{ Params: { name: string }; Body: { mode: string } }>(
    '/api/v1/admin/connections/:name/mode',
    async (req, reply) => {
      const { name } = req.params;
      const { mode } = req.body ?? {};
      if (mode !== 'live' && mode !== 'mock') {
        throw new AppError(400, "mode must be 'live' or 'mock'");
      }
      const op = operatorFromRequest(req);
      await setConnectionMode(name, mode as ConnectionMode, {
        operator_id: op.operator_id ?? null,
        actor_type: 'operator',
      });
      return reply.status(200).send({ mode });
    },
  );

  // ── Backward-compat /connections/stripe/* aliases ──────────────────────────
  // TO REMOVE after HUB-1795 (frontend cutover to the generic routes).
  //
  // These aliases route to the S8/S9 Stripe-specific registry directly (getStripeMode,
  // setStripeMode) rather than the new generic registry — Stripe hasn't been migrated to
  // the generic base yet (HUB-1794 / S5). Once S5 lands, the Stripe registry becomes a
  // shim over the generic one and these aliases can either delegate to the generic
  // handlers OR be removed. Keeping S4's blast radius small is the priority here.
  //
  // Fastify does not allow two routes with different paths but conflicting patterns to
  // silently coexist — /:name/mode with name='stripe' vs /stripe/mode are distinct paths
  // to Fastify's router, so both can be registered.
  fastify.get('/api/v1/admin/connections/stripe/mode', async (req) => {
    void req;
    return { mode: getStripeMode() };
  });

  fastify.get('/api/v1/admin/connections/stripe/status', async (req) => {
    void req;
    // Own local cache — matches S9 behavior exactly. Not delegating to the shared
    // getCachedStatus because Stripe isn't yet registered with the generic registry
    // (that's S5). Behavior identical to HUB-1782.
    const mode = getStripeMode();
    const key = `mode:${mode}`;
    const now = Date.now();
    if (_stripeAliasCache && _stripeAliasCache.key === key && _stripeAliasCache.expiresAt > now) {
      return _stripeAliasCache.result;
    }
    const checked_at = new Date().toISOString();
    let result: StripeStatusResult;
    if (mode === 'mock') {
      result = { mode, health: 'ok', checked_at, latency_ms: 0 };
    } else {
      const start = Date.now();
      try {
        const { getStripeConnection } = await import('../../stripe/registry.js');
        const probe = getStripeConnection().balance.retrieve();
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('probe timeout')), STRIPE_ALIAS_PROBE_TIMEOUT_MS),
        );
        await Promise.race([probe, timeout]);
        result = { mode, health: 'ok', checked_at, latency_ms: Date.now() - start };
      } catch (err) {
        const message = (err as Error).message;
        const isRateLimit = /rate_limit|rate limit|429/i.test(message);
        result = {
          mode,
          health: isRateLimit ? 'degraded' : 'down',
          reason: message,
          checked_at,
          latency_ms: Date.now() - start,
        };
      }
    }
    _stripeAliasCache = { key, result, expiresAt: now + STRIPE_ALIAS_CACHE_TTL_MS };
    return result;
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
