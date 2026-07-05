// Authorized by HUB-1707 — automated compat-window flip + 24h residual alert.
//   Replaces the HUB-1588 manual flip (docs/operations/role-rename-deploy.md)
//   with a BullMQ-driven closer that trips when either (a) no legacy claim has
//   been accepted for a 30-min quiet window, or (b) 24 h have elapsed since the
//   compat window started. At the 24 h mark with residual accepted claims,
//   emits a compliance alert instead of auto-flipping — requires manual
//   operator override so the security exposure does not silently persist.
import { getRedisClient } from '../redis/client.js';
import { getSetting, updateSetting } from './adminSettings.js';
import { writeAuditEntry } from './auditLogService.js';
import { deliverAlert } from './complianceAlertService.js';
import logger from '../lib/logger.js';

const COMPAT_FLAG_KEY = 'role_rename_compat_window_enabled';

// Counter incremented by operatorRbacHook every time it accepts a legacy
// tenant_admin claim. Deleted after the flag flips to keep future re-arms
// starting from a clean slate. // tenant-admin-rename:historical
const COUNTER_KEY = 'metrics:jwt.legacy_claim_accepted';
const LAST_AT_KEY = 'metrics:jwt.legacy_claim_accepted:last_at';
// Runtime-only marker: the ISO timestamp of the first CRON tick that observed
// the compat window in an enabled state. Used to bound the 24 h automated
// window without adding another operator-tunable setting.
const STARTED_AT_KEY = 'metrics:role_rename_compat_window:started_at';

export const QUIET_WINDOW_MS = 30 * 60 * 1000;
export const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

// Kept in sync with src/queues/cron.ts entry for role-rename-compat-flip. Used only
// by the post-flip removeRepeatable call so the CRON stops firing immediately after
// the flag flips (registerAllCronJobs at next worker restart will skip re-arming it).
const CRON_PATTERN = '*/5 * * * *';

// HUB-1087 internal tenant used for portfolio-scope audit entries (settings
// updates are not tenant-scoped; audit rows require a UUID).
const HUB_INTERNAL_TENANT_ID = '00000000-0000-0000-0000-000000000001';

export type FlipTrigger = 'no_legacy_claims_30m' | '24h_elapsed';

export interface FlipDecision {
  action: 'flip' | 'residual_alert' | 'wait' | 'noop';
  trigger?: FlipTrigger;
}

/**
 * Called from operatorRbacHook after the legacy tenant_admin claim is accepted.
 * Fire-and-forget: any Redis failure is logged and swallowed — the RBAC path
 * must not fail because telemetry storage is unreachable. // tenant-admin-rename:historical
 */
export async function incrementLegacyClaimCounter(): Promise<void> {
  try {
    const redis = getRedisClient();
    await redis.incr(COUNTER_KEY);
    await redis.set(LAST_AT_KEY, new Date().toISOString());
  } catch (err) {
    logger.warn({ err }, 'incrementLegacyClaimCounter: Redis write failed — telemetry skipped');
  }
}

/**
 * CRON entrypoint. Idempotent: reads the flag first and exits immediately if
 * already false so a stray tick after a flip does no work (AC 4).
 */
export async function runRoleRenameCompatFlip(nowMs: number = Date.now()): Promise<FlipDecision> {
  const flag = await getSetting(COMPAT_FLAG_KEY);
  if (flag !== true) {
    logger.debug('runRoleRenameCompatFlip: flag already false — no-op');
    return { action: 'noop' };
  }

  const redis = getRedisClient();
  const startedAtRaw = await redis.get(STARTED_AT_KEY);
  const nowIso = new Date(nowMs).toISOString();

  // First tick self-seeds started_at. Subsequent ticks compare against this.
  // The 24 h clock therefore begins at the first CRON observation, not at
  // migration deploy — documented in the setting description of
  // role_rename_compat_window_enabled and in role-rename-deploy.md.
  if (!startedAtRaw) {
    await redis.set(STARTED_AT_KEY, nowIso);
    logger.info(
      { event: 'role_rename_compat.window_started', started_at: nowIso },
      'compat window auto-seeded on first CRON tick',
    );
    return { action: 'wait' };
  }

  const startedAtMs = Date.parse(startedAtRaw);
  const ageMs = nowMs - startedAtMs;

  const counterRaw = await redis.get(COUNTER_KEY);
  const counter = counterRaw ? parseInt(counterRaw, 10) : 0;
  const lastAtRaw = await redis.get(LAST_AT_KEY);
  const lastAtMs = lastAtRaw ? Date.parse(lastAtRaw) : null;
  const quietForMs = lastAtMs === null ? ageMs : nowMs - lastAtMs;

  if (ageMs >= MAX_WINDOW_MS) {
    if (counter > 0) {
      // Residual — do NOT auto-flip. Emit a compliance alert so the operator
      // is forced to override the exposure explicitly.
      await deliverAlert({
        alertType: 'residual_legacy_claim_after_window',
        severity: 'high',
        payload: {
          counter,
          started_at: startedAtRaw,
          age_hours: ageMs / (60 * 60 * 1000),
          last_legacy_claim_at: lastAtRaw,
        },
        contentHashSeed: `residual_legacy_claim_after_window:${startedAtRaw}`,
      });
      logger.warn(
        {
          event: 'role_rename_compat.residual_after_24h',
          counter,
          last_legacy_claim_at: lastAtRaw,
        },
        'compat window exceeded 24h with residual legacy claims — alert emitted, flag not flipped',
      );
      return { action: 'residual_alert' };
    }
    return await flip('24h_elapsed', startedAtRaw, counter);
  }

  if (quietForMs >= QUIET_WINDOW_MS && ageMs >= QUIET_WINDOW_MS) {
    return await flip('no_legacy_claims_30m', startedAtRaw, counter);
  }

  return { action: 'wait' };
}

async function flip(
  trigger: FlipTrigger,
  startedAt: string,
  counterAtFlip: number,
): Promise<FlipDecision> {
  await updateSetting(COMPAT_FLAG_KEY, false);

  await writeAuditEntry({
    tenant_id: HUB_INTERNAL_TENANT_ID,
    actor_type: 'system',
    actor_id: 'role-rename-window-closed',
    operation: 'UPDATE',
    table_name: 'settings',
    record_id: COMPAT_FLAG_KEY,
    old_values: { value: true },
    new_values: {
      value: false,
      trigger,
      started_at: startedAt,
      counter_at_flip: counterAtFlip,
    },
  });

  // Clean up telemetry so a hypothetical re-arm (operator flips flag back
  // on manually) starts from a clean slate rather than inheriting stale values.
  try {
    const redis = getRedisClient();
    await redis.del(COUNTER_KEY, LAST_AT_KEY, STARTED_AT_KEY);
  } catch (err) {
    logger.warn({ err }, 'runRoleRenameCompatFlip: post-flip Redis cleanup failed');
  }

  // Stop the repeatable so the CRON no longer fires this tick's queue on the
  // current worker. registerAllCronJobs at next worker restart will observe the
  // flag=false and skip re-arming. Dynamic import avoids the circular dep
  // (queues/index → this service → queues/index).
  try {
    const { getRoleRenameCompatFlipQueue } = await import('../queues/index.js');
    await getRoleRenameCompatFlipQueue().removeRepeatable('role-rename-compat-flip', {
      pattern: CRON_PATTERN,
    });
  } catch (err) {
    logger.warn({ err }, 'runRoleRenameCompatFlip: post-flip removeRepeatable failed');
  }

  logger.info(
    {
      event: 'role_rename_compat.window_closed',
      trigger,
      counter_at_flip: counterAtFlip,
      started_at: startedAt,
    },
    'compat window closed automatically',
  );

  return { action: 'flip', trigger };
}
