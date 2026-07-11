// Authorized by HUB-1779 (S6 of HUB-1773) — file-based fixture importers for stripe_mock.
// Both `importCsv()` and `importJson()` funnel through the S5 programmatic seed API — no
// raw SQL, no bypassing Zod validation, no bypassing the mock-only guard. All-or-nothing
// semantics: any per-row parse/validation/FK failure rolls back the whole load.
//
// CSV format (documented in docs/stripe-mock-fixtures.md):
//   - One file per object type (customers.csv, products.csv, prices.csv, ...)
//   - Header row required, snake_case column names
//   - ID columns wire relationships (subscriptions.csv → customer_id column etc.)
//   - Timestamps as unix epoch seconds (Stripe convention)
//   - Empty cells → NULL for nullable fields; empty for required field is a validation error
//
// JSON format:
//   - Single file: `{ customers: [...], products: [...], prices: [...], ... }`
//     Insertion order is FK-safe: customers/products → prices/coupons → subscriptions →
//     invoices/discounts/balanceTransactions.
//   - NDJSON: one JSON object per line, each with a `_object` discriminator (e.g.
//     `{"_object":"customer","email":"a@b.co"}`). Grouped by _object and inserted in the
//     same FK-safe order.
import fs from 'node:fs/promises';
import { parse as parseCsv } from 'csv-parse/sync';
import { AppError } from '../../errors/AppError.js';
import { assertMockMode } from './guard.js';
import { seed, type CustomerSeed, type ProductSeed, type PriceSeed, type CouponSeed,
  type SubscriptionSeed, type InvoiceSeed, type DiscountSeed, type BalanceTransactionSeed,
} from './index.js';

// ── Object types recognized by the importers ────────────────────────────────────

export type ObjectType =
  | 'customers'
  | 'products'
  | 'prices'
  | 'coupons'
  | 'subscriptions'
  | 'invoices'
  | 'discounts'
  | 'balance_transactions';

// ── ImportResult ────────────────────────────────────────────────────────────────

export interface ImportResult {
  success: boolean;
  rowsAttempted: number;
  rowsCommitted: number;
  errors: Array<{ objectType?: string; row?: number; field?: string; message: string }>;
}

// ── CSV parsing ─────────────────────────────────────────────────────────────────

// Coerce string CSV cells into typed seed inputs. Empty cells become undefined (Zod
// applies defaults or nullable/optional at parse time). Numeric columns are coerced.
function coerceCsvRow(objectType: ObjectType, row: Record<string, string>): unknown {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(row)) {
    if (raw === '' || raw === undefined) continue;
    // Numeric columns per object type
    if (
      (objectType === 'customers' && key === 'created') ||
      (objectType === 'products' && key === 'created') ||
      (objectType === 'prices' && ['created', 'unit_amount', 'recurring_interval_count'].includes(key)) ||
      (objectType === 'coupons' && ['created', 'percent_off', 'amount_off', 'duration_in_months'].includes(key)) ||
      (objectType === 'subscriptions' && ['created', 'current_period_start', 'current_period_end', 'canceled_at'].includes(key)) ||
      (objectType === 'invoices' && ['created', 'amount_due', 'amount_paid', 'period_start', 'period_end'].includes(key)) ||
      (objectType === 'discounts' && ['start', 'end'].includes(key)) ||
      (objectType === 'balance_transactions' && ['created', 'amount'].includes(key))
    ) {
      const n = Number(raw);
      if (Number.isNaN(n)) {
        throw new AppError(400, `Cannot parse "${raw}" as number for ${objectType}.${key}`);
      }
      out[key] = n;
      continue;
    }
    // Boolean columns
    if (
      (objectType === 'customers' && key === 'livemode') ||
      (objectType === 'products' && key === 'active') ||
      (objectType === 'prices' && key === 'active') ||
      (objectType === 'coupons' && key === 'valid') ||
      (objectType === 'subscriptions' && key === 'cancel_at_period_end')
    ) {
      if (raw === 'true') out[key] = true;
      else if (raw === 'false') out[key] = false;
      else throw new AppError(400, `Cannot parse "${raw}" as boolean for ${objectType}.${key}`);
      continue;
    }
    // JSON columns (metadata)
    if (key === 'metadata') {
      try {
        out[key] = JSON.parse(raw);
      } catch {
        throw new AppError(400, `Cannot parse metadata JSON for ${objectType}: ${raw}`);
      }
      continue;
    }
    // Subscription items column: JSON array
    if (objectType === 'subscriptions' && key === 'items') {
      try {
        out[key] = JSON.parse(raw);
      } catch {
        throw new AppError(400, `Cannot parse items JSON for subscription: ${raw}`);
      }
      continue;
    }
    // Default: string
    out[key] = raw;
  }
  return out;
}

/**
 * Import a single CSV file of a specific object type. Every row is validated + inserted
 * through the S5 seed API's transactional path, so all-or-nothing semantics apply.
 *
 * On any per-row validation or orphan-reference failure the whole load rolls back and
 * this function returns an ImportResult with `success: false` and per-row errors —
 * OR throws AppError(400) with the same information if the underlying seed call
 * rejected. Either way, no partial rows persist.
 */
export async function importCsv(filePath: string, objectType: ObjectType): Promise<ImportResult> {
  // Guard first — if mode is live, we don't even open the file. Any subsequent path
  // that hits the seed API would throw anyway; short-circuiting here keeps the error
  // message consistent (importCsv result surface, not a seed.reset failure).
  try {
    assertMockMode();
  } catch (err) {
    return { success: false, rowsAttempted: 0, rowsCommitted: 0, errors: [{ message: (err as AppError).message }] };
  }

  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    throw new AppError(400, `Cannot read CSV file ${filePath}: ${(err as Error).message}`);
  }

  let rows: Array<Record<string, string>>;
  try {
    rows = parseCsv(raw, { columns: true, skip_empty_lines: true }) as Array<Record<string, string>>;
  } catch (err) {
    throw new AppError(400, `Malformed CSV: ${(err as Error).message}`);
  }

  const coerced: unknown[] = [];
  const errors: ImportResult['errors'] = [];
  rows.forEach((row, i) => {
    try {
      coerced.push(coerceCsvRow(objectType, row));
    } catch (err) {
      errors.push({ objectType, row: i, message: (err as Error).message });
    }
  });
  if (errors.length > 0) {
    return { success: false, rowsAttempted: rows.length, rowsCommitted: 0, errors };
  }

  try {
    await insertBatch(objectType, coerced);
    return { success: true, rowsAttempted: rows.length, rowsCommitted: rows.length, errors: [] };
  } catch (err) {
    return {
      success: false,
      rowsAttempted: rows.length,
      rowsCommitted: 0,
      errors: [{ objectType, message: (err as AppError).message }],
    };
  }
}

// ── JSON parsing ────────────────────────────────────────────────────────────────

// FK-safe insertion order: parents before children.
const INSERT_ORDER: ObjectType[] = [
  'customers',
  'products',
  'coupons',
  'prices',
  'subscriptions',
  'invoices',
  'discounts',
  'balance_transactions',
];

// Stripe events emit singular `object` names (customer, price, subscription, ...).
// NDJSON fixtures may use either singular or plural.
const SINGULAR_TO_PLURAL: Record<string, ObjectType> = {
  customer: 'customers',
  product: 'products',
  price: 'prices',
  coupon: 'coupons',
  subscription: 'subscriptions',
  invoice: 'invoices',
  discount: 'discounts',
  balance_transaction: 'balance_transactions',
};

// Single-JSON shape: { customers: [...], products: [...], ... }
type JsonBundle = Partial<Record<ObjectType, unknown[]>>;

/**
 * Import a JSON or NDJSON file. Both formats resolve to a bundle grouped by object type;
 * insertion runs in FK-safe order. Every group inserts through the S5 seed API. On any
 * failure the whole load rolls back and returns success:false with the failing group's
 * per-row errors OR throws AppError.
 *
 * Single JSON shape: `{ customers: [...], products: [...], subscriptions: [...] }`.
 * NDJSON shape: one object per line, each carrying a `_object` discriminator.
 */
export async function importJson(filePath: string): Promise<ImportResult> {
  // Guard first — same short-circuit reason as importCsv.
  try {
    assertMockMode();
  } catch (err) {
    return { success: false, rowsAttempted: 0, rowsCommitted: 0, errors: [{ message: (err as AppError).message }] };
  }

  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    throw new AppError(400, `Cannot read JSON file ${filePath}: ${(err as Error).message}`);
  }

  const bundle = parseJsonOrNdjson(raw);
  return runBundle(bundle);
}

function parseJsonOrNdjson(raw: string): JsonBundle {
  const trimmed = raw.trim();
  // Try single-JSON first — if it parses to an object with recognized keys, use it.
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const bundle: JsonBundle = {};
      for (const key of INSERT_ORDER) {
        if (Array.isArray(parsed[key])) {
          bundle[key] = parsed[key] as unknown[];
        }
      }
      return bundle;
    } catch (err) {
      // Fall through to NDJSON if single-JSON parse failed.
      if (!(err instanceof SyntaxError)) throw err;
    }
  }

  // NDJSON: one line per record.
  const bundle: JsonBundle = {};
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim() !== '');
  lines.forEach((line, i) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new AppError(400, `NDJSON line ${i + 1} is not valid JSON: ${(err as Error).message}`);
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new AppError(400, `NDJSON line ${i + 1} is not an object`);
    }
    const rec = parsed as Record<string, unknown>;
    const rawObj = rec._object as string | undefined;
    if (!rawObj) {
      throw new AppError(400, `NDJSON line ${i + 1} missing _object discriminator`);
    }
    // Accept both singular (Stripe API convention: object=customer) and plural forms.
    const objectType = SINGULAR_TO_PLURAL[rawObj] ?? (rawObj as ObjectType);
    if (!INSERT_ORDER.includes(objectType)) {
      throw new AppError(400, `NDJSON line ${i + 1} has unknown _object: ${rawObj}`);
    }
    delete rec._object;
    (bundle[objectType] ??= []).push(rec);
  });
  return bundle;
}

async function runBundle(bundle: JsonBundle): Promise<ImportResult> {
  const totalAttempted = INSERT_ORDER.reduce((n, ot) => n + (bundle[ot]?.length ?? 0), 0);
  let committed = 0;
  const errors: ImportResult['errors'] = [];
  for (const objectType of INSERT_ORDER) {
    const items = bundle[objectType];
    if (!items || items.length === 0) continue;
    try {
      await insertBatch(objectType, items);
      committed += items.length;
    } catch (err) {
      errors.push({ objectType, message: (err as AppError).message });
      // All-or-nothing: rewind any previously-committed groups by resetting the mock store.
      // We do NOT partially return committed inserts — the caller sees success:false.
      await seed.reset();
      return { success: false, rowsAttempted: totalAttempted, rowsCommitted: 0, errors };
    }
  }
  return { success: true, rowsAttempted: totalAttempted, rowsCommitted: committed, errors };
}

// ── Dispatch to the correct seed facet ──────────────────────────────────────────

async function insertBatch(objectType: ObjectType, items: unknown[]): Promise<void> {
  switch (objectType) {
    case 'customers':
      await seed.customers.create(items as CustomerSeed[]);
      return;
    case 'products':
      await seed.products.create(items as ProductSeed[]);
      return;
    case 'prices':
      await seed.prices.create(items as PriceSeed[]);
      return;
    case 'coupons':
      await seed.coupons.create(items as CouponSeed[]);
      return;
    case 'subscriptions':
      await seed.subscriptions.create(items as SubscriptionSeed[]);
      return;
    case 'invoices':
      await seed.invoices.create(items as InvoiceSeed[]);
      return;
    case 'discounts':
      await seed.discounts.create(items as DiscountSeed[]);
      return;
    case 'balance_transactions':
      await seed.balanceTransactions.create(items as BalanceTransactionSeed[]);
      return;
  }
}
