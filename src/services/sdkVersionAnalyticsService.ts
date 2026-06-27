// Authorized by HUB-1698 (E-BE-1 S21) — SDK version analytics aggregator for the E-FE-10
// SDK Version Distribution Epic (HUB-1560). Three pure-aggregation functions over
// sdk_version_reports + sdk_versions registry. Status taxonomy (HUB-1633 consumer):
//   - 'eol'     reported version row has eol_at NOT NULL in the registry
//   - 'stale'   last report > sdk_stale_threshold_days ago (orthogonal — wins over behind)
//   - 'behind'  reported version known to the registry but not is_latest=true
//   - 'current' reported version = the is_latest=true row for the sdk
// Priority on collision: eol > stale > behind > current.
//
// v0.1 SDK list (HUB-1631 R1 allowlist + 054 seed): hub-sdk, synapz-sdk. Adding a new SDK
// requires: (a) INSERT into sdk_versions, (b) update FE allowlist in
// frontend/src/types/sdkRegistry.ts. No code change here.
//
// Spec deviation: story spec assumed sdk_version_reports had an sdk_name column. Added
// via migration 054 (NOT NULL DEFAULT 'hub-sdk'; existing rows backfilled).

import { getPool } from '../db/pool.js';
import { getSetting } from './adminSettings.js';
import logger from '../lib/logger.js';

const SDK_STALE_THRESHOLD_DAYS_KEY = 'sdk_stale_threshold_days';
const SDK_STALE_THRESHOLD_DAYS_DEFAULT = 30;

export interface DistributionRow {
  version: string;
  count: number;
  products: string[];
}

export interface ProductBreakdownRow {
  productId: string;
  productName: string;
  currentVersion: string;
  lastReportedAt: string;
  daysBehindLatest: number;
  status: 'current' | 'behind' | 'eol' | 'stale';
}

export interface ImpactPreviewResult {
  impactedCount: number;
  products: Array<{ productId: string; productName: string; currentVersion: string }>;
}

async function readStaleThresholdDays(): Promise<number> {
  try {
    const v = await getSetting(SDK_STALE_THRESHOLD_DAYS_KEY);
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  } catch (err) {
    logger.warn({ err }, 'sdkVersionAnalytics: stale threshold setting fetch failed; using default');
  }
  return SDK_STALE_THRESHOLD_DAYS_DEFAULT;
}

/**
 * Per-version fleet distribution for a single SDK. Joins reports → product_registrations
 * → products to surface product display names. Ordering follows the registry's released_at
 * so the chart axis is chronologically meaningful (latest first).
 */
export async function getDistribution(sdkName: string): Promise<DistributionRow[]> {
  const pool = getPool();
  const { rows } = await pool.query<{
    version: string;
    count: string;
    products: string[];
  }>(
    `SELECT r.sdk_version AS version,
            COUNT(DISTINCT r.product_id)::bigint AS count,
            ARRAY_AGG(DISTINCT p.name ORDER BY p.name) AS products
       FROM sdk_version_reports r
       JOIN product_registrations pr ON pr.id = r.product_id
       JOIN products p ON p.id = pr.product_id
  LEFT JOIN sdk_versions v ON v.sdk_name = r.sdk_name AND v.version = r.sdk_version
      WHERE r.sdk_name = $1
   GROUP BY r.sdk_version, v.released_at
   ORDER BY v.released_at DESC NULLS LAST, r.sdk_version DESC`,
    [sdkName],
  );

  return rows.map((r) => ({
    version: r.version,
    count: parseInt(r.count, 10),
    products: r.products ?? [],
  }));
}

interface RegistryRow {
  version: string;
  is_latest: boolean;
  eol_at: Date | null;
  released_at: Date;
}

async function loadRegistry(pool: ReturnType<typeof getPool>, sdkName: string): Promise<RegistryRow[]> {
  const { rows } = await pool.query<RegistryRow>(
    `SELECT version, is_latest, eol_at, released_at
       FROM sdk_versions
      WHERE sdk_name = $1
      ORDER BY released_at DESC`,
    [sdkName],
  );
  return rows;
}

function classifyStatus(
  version: string,
  lastReportedAt: Date,
  registry: Map<string, RegistryRow>,
  latestVersion: string | null,
  staleThresholdMs: number,
  now: number,
): 'current' | 'behind' | 'eol' | 'stale' {
  const reg = registry.get(version);
  if (reg?.eol_at !== null && reg?.eol_at !== undefined) return 'eol';
  if (now - lastReportedAt.getTime() > staleThresholdMs) return 'stale';
  if (latestVersion !== null && version !== latestVersion) return 'behind';
  return 'current';
}

function daysBehindLatest(
  version: string,
  registry: Map<string, RegistryRow>,
  latestVersion: string | null,
): number {
  if (latestVersion === null || version === latestVersion) return 0;
  const reg = registry.get(version);
  const latestReg = registry.get(latestVersion);
  if (!reg || !latestReg) return 0;
  const diffMs = latestReg.released_at.getTime() - reg.released_at.getTime();
  if (diffMs <= 0) return 0;
  return Math.floor(diffMs / (24 * 60 * 60 * 1000));
}

/**
 * Per product_registration row: current reported version + status classification.
 * Status priority documented at file header: eol > stale > behind > current.
 */
export async function getProductBreakdown(sdkName: string): Promise<ProductBreakdownRow[]> {
  const pool = getPool();
  const registryRows = await loadRegistry(pool, sdkName);
  const registry = new Map<string, RegistryRow>(registryRows.map((r) => [r.version, r]));
  const latestVersion = registryRows.find((r) => r.is_latest)?.version ?? null;

  const staleDays = await readStaleThresholdDays();
  const staleThresholdMs = staleDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const { rows } = await pool.query<{
    product_id: string;
    product_name: string;
    current_version: string;
    last_reported_at: Date;
  }>(
    `SELECT r.product_id,
            p.name AS product_name,
            r.sdk_version AS current_version,
            r.reported_at AS last_reported_at
       FROM sdk_version_reports r
       JOIN product_registrations pr ON pr.id = r.product_id
       JOIN products p ON p.id = pr.product_id
      WHERE r.sdk_name = $1
   ORDER BY p.name ASC`,
    [sdkName],
  );

  return rows.map((r) => ({
    productId: r.product_id,
    productName: r.product_name,
    currentVersion: r.current_version,
    lastReportedAt: r.last_reported_at.toISOString(),
    daysBehindLatest: daysBehindLatest(r.current_version, registry, latestVersion),
    status: classifyStatus(
      r.current_version,
      r.last_reported_at,
      registry,
      latestVersion,
      staleThresholdMs,
      now,
    ),
  }));
}

/**
 * Deprecation impact preview: which products are on a version ≤ the deprecated one.
 * Lexicographic comparison is correct for the MAJOR.MINOR.PATCH pattern that the
 * route-layer regex enforces (each segment is a single integer field, zero-padded
 * implicitly by the fixed 3-segment shape).
 */
export async function getImpactPreview(
  sdkName: string,
  deprecatedVersion: string,
): Promise<ImpactPreviewResult> {
  const pool = getPool();
  const { rows } = await pool.query<{
    product_id: string;
    product_name: string;
    current_version: string;
  }>(
    `SELECT r.product_id,
            p.name AS product_name,
            r.sdk_version AS current_version
       FROM sdk_version_reports r
       JOIN product_registrations pr ON pr.id = r.product_id
       JOIN products p ON p.id = pr.product_id
      WHERE r.sdk_name = $1 AND r.sdk_version <= $2
   ORDER BY p.name ASC`,
    [sdkName, deprecatedVersion],
  );

  return {
    impactedCount: rows.length,
    products: rows.map((r) => ({
      productId: r.product_id,
      productName: r.product_name,
      currentVersion: r.current_version,
    })),
  };
}
