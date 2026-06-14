// Authorized by HUB-335 — checkVersionCompatibility(); indexed version gate; sunset enforcement
// Authorized by HUB-336 — recordSdkVersion(); upsert + Redis broadcast; pruneOldVersionReports() + CRON guard
import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';
import logger from '../lib/logger.js';
import { getRedisClient } from '../redis/client.js';
import type { SdkVersionReportRow } from '../db/schema/sdk_version_reports.js';
import { TODO_D_DEF_002_INTERVAL } from '../config/decisions.js';

// ── checkVersionCompatibility ─────────────────────────────────────────────────

export async function checkVersionCompatibility(
  productId: string,
  sdkVersion: string,
): Promise<{ status: 'supported' | 'deprecated'; deprecated_at: Date | null; sunset_at: Date | null }> {
  const pool = getPool();

  const { rows } = await pool.query<{
    status: string;
    deprecated_at: Date | null;
    sunset_at: Date | null;
  }>(
    `SELECT status, deprecated_at, sunset_at
     FROM product_versions
     WHERE product_id = $1 AND version = $2`,
    [productId, sdkVersion],
  );

  if (!rows[0]) throw new AppError(404, 'Unknown SDK version');

  const { status, deprecated_at, sunset_at } = rows[0];

  if (status === 'sunset') throw new AppError(403, 'SDK version sunset; upgrade required');

  return { status: status as 'supported' | 'deprecated', deprecated_at, sunset_at };
}

// ── recordSdkVersion ──────────────────────────────────────────────────────────

export async function recordSdkVersion(
  tenantId: string,
  productId: string,
  sdkVersion: string,
): Promise<SdkVersionReportRow> {
  await checkVersionCompatibility(productId, sdkVersion);

  const pool = getPool();

  const { rows } = await pool.query<SdkVersionReportRow>(
    `INSERT INTO sdk_version_reports (tenant_id, product_id, sdk_version, reported_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (tenant_id, product_id) DO UPDATE
       SET sdk_version = EXCLUDED.sdk_version,
           reported_at = NOW()
     RETURNING *`,
    [tenantId, productId, sdkVersion],
  );

  const row = rows[0]!;

  // Post-commit: broadcast version report signal (fire-and-forget)
  try {
    const redis = getRedisClient();
    await redis.publish(
      `hub:sdk:version-report:${productId}`,
      JSON.stringify({ tenantId, productId, sdkVersion, reportedAt: row.reported_at }),
    );
  } catch (err) {
    logger.warn({ err, productId, tenantId }, 'SDK version report broadcast failed');
  }

  return row;
}

// ── pruneOldVersionReports ────────────────────────────────────────────────────

export async function pruneOldVersionReports(): Promise<void> {
  if (TODO_D_DEF_002_INTERVAL === null) {
    throw new AppError(500, 'SDK version retention interval not configured');
  }

  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM sdk_version_reports WHERE reported_at < NOW() - $1::interval`,
    [TODO_D_DEF_002_INTERVAL],
  );

  logger.info({ pruned: rowCount ?? 0, interval: TODO_D_DEF_002_INTERVAL }, 'SDK version reports pruned');
}
