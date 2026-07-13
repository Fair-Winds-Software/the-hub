// Authorized by HUB-1803 (S1 of HUB-1785) — canonical KPI catalog for HUB's BI Layer.
// Every metric HUB ingests must be listed here. Adding a metric is a Story-scoped
// decision (not runtime config); ingestion drops (with an audit trail) any metric_name
// not present in this registry so we're forced to grow the catalog explicitly.
//
// Type + rollup semantics:
//   type:    'int' | 'float' | 'enum:<v1>|<v2>|...'  — how `value` is stored + validated.
//                                                     int/float → value_num column;
//                                                     enum      → value_str column.
//   rollup:  'sum' | 'avg' | 'max' | 'last'          — how S4's rollup service folds
//                                                     raw events into per-window buckets.
//                                                     'last' = most-recent occurred_at.
//
// dimensions: optional split-by keys. Ingestion accepts a `dimensions` object; only keys
// listed here are honored (extras dropped) — keeps rollup cardinality controlled.
import { z } from 'zod';

export type MetricType = 'int' | 'float' | `enum:${string}`;
export type RollupSemantic = 'sum' | 'avg' | 'max' | 'last';

export interface MetricCatalogEntry {
  name: string;
  type: MetricType;
  rollup: RollupSemantic;
  dimensions: readonly string[];
  description: string;
}

// ── Canonical v1 registry ──────────────────────────────────────────────────────

const CATALOG: readonly MetricCatalogEntry[] = [
  {
    name: 'daily_active_users',
    type: 'int',
    rollup: 'sum',
    dimensions: [],
    description: 'Unique users active in a 24h window. Portfolio DAU is the sum across products.',
  },
  {
    name: 'logins',
    type: 'int',
    rollup: 'sum',
    dimensions: ['operator_role'],
    description: 'Login events. Optional dimension operator_role for split (product_admin / super_admin / end_user).',
  },
  {
    name: 'mrr_cents',
    type: 'int',
    rollup: 'last',
    dimensions: ['plan_id'],
    description: 'Monthly recurring revenue in USD cents. `last` semantic — the most recent bucket value wins.',
  },
  {
    name: 'churn_rate',
    type: 'float',
    rollup: 'avg',
    dimensions: [],
    description: 'Fraction of paying customers who churned in the period. Range [0, 1].',
  },
  {
    name: 'feature_adoption',
    type: 'float',
    rollup: 'avg',
    dimensions: ['feature'],
    description: 'Fraction of DAU that engaged with a named feature. Required dimension `feature`.',
  },
  {
    name: 'app_health_status',
    type: 'enum:ok|degraded|down',
    rollup: 'last',
    dimensions: [],
    description: 'Synthetic app-side health push. Powers the per-product health badge on the Dashboard + drill-in.',
  },
] as const;

// ── Accessors ──────────────────────────────────────────────────────────────────

const CATALOG_INDEX = new Map(CATALOG.map((e) => [e.name, e]));

export function getCatalogEntry(name: string): MetricCatalogEntry | undefined {
  return CATALOG_INDEX.get(name);
}

export function listCatalog(): readonly MetricCatalogEntry[] {
  return CATALOG;
}

// ── Zod wire schema ────────────────────────────────────────────────────────────
// Wire-level validation only — per-metric type checking happens in
// validateEventAgainstCatalog() so ingestion can drop mismatched events (with a
// per-event reason) instead of rejecting the whole batch.

export const MetricEventInput = z.object({
  product_id: z.string().uuid(),
  metric_name: z.string().min(1),
  dimensions: z.record(z.string(), z.string()).optional(),
  value: z.union([z.number(), z.string()]),
  occurred_at: z.string().datetime(),
});
export type MetricEventInput = z.infer<typeof MetricEventInput>;

// ── Per-metric value validation ────────────────────────────────────────────────

export type ValueValidationResult =
  | { ok: true; value_num: number | null; value_str: string | null }
  | { ok: false; reason: string };

function parseEnumType(type: MetricType): string[] | null {
  if (!type.startsWith('enum:')) return null;
  return type.slice('enum:'.length).split('|');
}

/**
 * Validate an incoming `value` against a catalog entry's declared type.
 * Returns the split (value_num | value_str) that the DB layer should insert.
 */
export function validateValue(
  entry: MetricCatalogEntry,
  value: number | string,
): ValueValidationResult {
  if (entry.type === 'int') {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return { ok: false, reason: `value must be an integer for metric '${entry.name}'` };
    }
    return { ok: true, value_num: value, value_str: null };
  }
  if (entry.type === 'float') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { ok: false, reason: `value must be a finite number for metric '${entry.name}'` };
    }
    return { ok: true, value_num: value, value_str: null };
  }
  const enumValues = parseEnumType(entry.type);
  if (enumValues) {
    if (typeof value !== 'string' || !enumValues.includes(value)) {
      return {
        ok: false,
        reason: `value must be one of [${enumValues.join(', ')}] for metric '${entry.name}'`,
      };
    }
    return { ok: true, value_num: null, value_str: value };
  }
  return { ok: false, reason: `unrecognized catalog type '${entry.type}'` };
}

/**
 * Strip dimensions to only the keys the catalog entry declares. Extras are dropped
 * (no error — keeps ingestion permissive).
 */
export function filterDimensions(
  entry: MetricCatalogEntry,
  dimensions: Record<string, string> | undefined,
): Record<string, string> {
  if (!dimensions) return {};
  const out: Record<string, string> = {};
  for (const key of entry.dimensions) {
    if (dimensions[key] !== undefined) {
      out[key] = dimensions[key]!;
    }
  }
  return out;
}
