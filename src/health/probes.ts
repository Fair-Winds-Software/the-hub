// Authorized by HUB-217 — standalone health probe module; pg/Redis/Stripe reachability; Promise.allSettled concurrency
import { getPool } from '../db/pool.js';
import { getRedisClient } from '../redis/client.js';
import { getStripeClient } from '../stripe/client.js';
import logger from '../lib/logger.js';

export type ProbeStatus = 'ok' | 'error' | 'timeout';
export type StripeProbeStatus = ProbeStatus | 'disabled';

export interface HealthCheckResult {
  pg: ProbeStatus;
  redis: ProbeStatus;
  stripe: StripeProbeStatus;
}

const PROBE_TIMEOUT_MS = 2000;

// Resolves (never rejects) to 'timeout' after ms — keeps Promise.race free of
// unhandled rejections; probes that outlive the window are silently abandoned.
function timeoutMs(ms: number): Promise<'timeout'> {
  return new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms));
}

// Races a probe against the timeout. Probe rejections are caught here and
// mapped to 'error' so Promise.race always receives two resolving promises.
function runProbe(
  name: string,
  probeFn: () => Promise<'ok'>,
  ms: number,
): Promise<ProbeStatus> {
  const result = probeFn().catch((err: unknown): ProbeStatus => {
    // Log error.message only — never stack trace or connection params (security)
    logger.debug({ probe: name, errMsg: (err as Error).message }, 'health probe failed');
    return 'error';
  });
  return Promise.race([result, timeoutMs(ms)]);
}

async function pgProbe(): Promise<'ok'> {
  await getPool().query('SELECT 1');
  return 'ok';
}

async function redisProbe(): Promise<'ok'> {
  await getRedisClient().ping();
  return 'ok';
}

async function stripeProbe(): Promise<'ok'> {
  await getStripeClient().balance.retrieve();
  return 'ok';
}

export async function runHealthChecks(): Promise<HealthCheckResult> {
  const stripeEnabled = process.env.HEALTH_CHECK_STRIPE_ENABLED !== 'false';

  const stripePromise: Promise<ProbeStatus | 'disabled'> = stripeEnabled
    ? runProbe('stripe', stripeProbe, PROBE_TIMEOUT_MS)
    : Promise.resolve<'disabled'>('disabled');

  const [pgResult, redisResult, stripeResult] = await Promise.allSettled([
    runProbe('pg', pgProbe, PROBE_TIMEOUT_MS),
    runProbe('redis', redisProbe, PROBE_TIMEOUT_MS),
    stripePromise,
  ] as [Promise<ProbeStatus>, Promise<ProbeStatus>, Promise<ProbeStatus | 'disabled'>]);

  return {
    pg: pgResult.status === 'fulfilled' ? pgResult.value : 'error',
    redis: redisResult.status === 'fulfilled' ? redisResult.value : 'error',
    stripe: stripeResult.status === 'fulfilled' ? stripeResult.value : 'error',
  };
}
