// Authorized by HUB-217 — standalone health probe module; pg/Redis/Stripe reachability; Promise.allSettled concurrency
// Authorized by HUB-1514 — ProbeResult with latency_ms; queue probe via DLQ; /ready endpoint support
// Authorized by HUB-1526 (FVL-E35) — ProbeStatus renamed to spec values (down/degraded); pg→db; timeout 2000→500ms
import { getPool } from "../db/pool.js";
import { getRedisClient } from "../redis/client.js";
import { getStripeClient } from "../stripe/client.js";
import { getDlqQueue } from "../queues/index.js";
import logger from "../lib/logger.js";

export type ProbeStatus = "ok" | "degraded" | "down";

export interface ProbeResult {
  status: ProbeStatus;
  latency_ms: number;
}

export interface StripeProbeResult {
  status: ProbeStatus | "disabled";
  latency_ms: number;
}

export interface HealthCheckResult {
  db: ProbeResult;
  redis: ProbeResult;
  stripe: StripeProbeResult;
  queue: ProbeResult;
}

const PROBE_TIMEOUT_MS = 500;

function runProbe(
  name: string,
  probeFn: () => Promise<"ok">,
  ms: number,
): Promise<ProbeResult> {
  const start = Date.now();
  const probeP: Promise<ProbeStatus> = probeFn().catch(
    (err: unknown): ProbeStatus => {
      logger.debug(
        { probe: name, errMsg: (err as Error).message },
        "health probe failed",
      );
      return "down";
    },
  );
  const timeoutP: Promise<ProbeStatus> = new Promise<ProbeStatus>((resolve) =>
    setTimeout(() => resolve("degraded"), ms),
  );
  return Promise.race([probeP, timeoutP]).then(
    (status): ProbeResult => ({
      status,
      latency_ms: Date.now() - start,
    }),
  );
}

async function pgProbe(): Promise<"ok"> {
  await getPool().query("SELECT 1");
  return "ok";
}

async function redisProbe(): Promise<"ok"> {
  await getRedisClient().ping();
  return "ok";
}

async function stripeProbe(): Promise<"ok"> {
  await getStripeClient().balance.retrieve();
  return "ok";
}

async function queueProbe(): Promise<"ok"> {
  await getDlqQueue().getJobCounts();
  return "ok";
}

export async function runHealthChecks(): Promise<HealthCheckResult> {
  const stripeEnabled = process.env.HEALTH_CHECK_STRIPE_ENABLED !== "false";

  const stripePromise: Promise<StripeProbeResult> = stripeEnabled
    ? runProbe("stripe", stripeProbe, PROBE_TIMEOUT_MS)
    : Promise.resolve<StripeProbeResult>({ status: "disabled", latency_ms: 0 });

  const [pgResult, redisResult, stripeResult, queueResult] =
    await Promise.allSettled([
      runProbe("pg", pgProbe, PROBE_TIMEOUT_MS),
      runProbe("redis", redisProbe, PROBE_TIMEOUT_MS),
      stripePromise,
      runProbe("queue", queueProbe, PROBE_TIMEOUT_MS),
    ] as [
      Promise<ProbeResult>,
      Promise<ProbeResult>,
      Promise<StripeProbeResult>,
      Promise<ProbeResult>,
    ]);

  const errResult: ProbeResult = { status: "down", latency_ms: 0 };
  const errStripe: StripeProbeResult = { status: "down", latency_ms: 0 };

  return {
    db: pgResult.status === "fulfilled" ? pgResult.value : errResult,
    redis: redisResult.status === "fulfilled" ? redisResult.value : errResult,
    stripe:
      stripeResult.status === "fulfilled" ? stripeResult.value : errStripe,
    queue: queueResult.status === "fulfilled" ? queueResult.value : errResult,
  };
}
