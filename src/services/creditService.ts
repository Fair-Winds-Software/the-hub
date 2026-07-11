// Authorized by HUB-1482 — grantCredit(): Stripe customer balance transaction + immutable ledger INSERT
import { getPool } from '../db/pool.js';
import { mapStripeError } from '../stripe/client.js';
import { getStripeConnection } from '../stripe/registry.js';
import { AppError } from '../errors/AppError.js';

export interface CreditDef {
  credit_amount_cents: number;
  currency?: string;
  memo?: string;
  accounting_period?: string;
  granted_by?: string;
}

export interface CustomerCreditRow {
  id: string;
  tenant_id: string;
  product_id: string | null;
  credit_amount_cents: number;
  currency: string;
  description: string;
  accounting_period: string;
  stripe_balance_applied: boolean;
  stripe_balance_applied_at: Date | null;
  stripe_balance_txn_id: string | null;
  created_by: string;
  created_at: Date;
}

async function withStripeTimeout<T>(fn: () => Promise<T>, ms = 5000): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Stripe API call timed out after 5s')), ms),
  );
  return Promise.race([fn(), timeout]);
}

// Grants a credit to a tenant by creating a Stripe customer balance transaction.
// Inserts an immutable customer_credits row after the Stripe call succeeds.
export async function grantCredit(
  tenantId: string,
  productId: string,
  def: CreditDef,
): Promise<CustomerCreditRow> {
  if (!def.credit_amount_cents || def.credit_amount_cents <= 0) {
    throw new AppError(400, 'credit_amount_cents must be positive');
  }

  const accountingPeriod =
    def.accounting_period && /^\d{4}-\d{2}$/.test(def.accounting_period)
      ? def.accounting_period
      : new Date().toISOString().slice(0, 7);

  const pool = getPool();
  const { rows: custRows } = await pool.query<{ stripe_customer_id: string }>(
    'SELECT stripe_customer_id FROM stripe_customers WHERE tenant_id = $1',
    [tenantId],
  );
  if (!custRows[0]) throw new AppError(400, 'No Stripe customer for tenant');
  const customerId = custRows[0].stripe_customer_id;

  const stripe = getStripeConnection();
  let stripeTxnId: string;
  try {
    const txn = await withStripeTimeout(() =>
      stripe.customers.createBalanceTransaction(customerId, {
        amount: -(def.credit_amount_cents),
        currency: def.currency ?? 'usd',
        description: def.memo ?? null,
      } as Parameters<typeof stripe.customers.createBalanceTransaction>[1]),
    );
    stripeTxnId = txn.id;
  } catch (err) {
    mapStripeError(err);
    throw err;
  }

  const { rows } = await pool.query<CustomerCreditRow>(
    `INSERT INTO customer_credits
       (tenant_id, product_id, credit_amount_cents, currency, description,
        accounting_period, stripe_balance_applied, stripe_balance_applied_at,
        stripe_balance_txn_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,true,NOW(),$7,$8)
     RETURNING *`,
    [
      tenantId,
      productId,
      def.credit_amount_cents,
      def.currency ?? 'usd',
      def.memo ?? '',
      accountingPeriod,
      stripeTxnId,
      def.granted_by ?? '',
    ],
  );
  return rows[0]!;
}

// Lists all credits for a tenant (ordered by created_at DESC).
export async function listCredits(
  tenantId: string,
  productId?: string,
): Promise<CustomerCreditRow[]> {
  const pool = getPool();
  const { rows } = await pool.query<CustomerCreditRow>(
    `SELECT * FROM customer_credits
     WHERE tenant_id = $1
     ${productId ? 'AND product_id = $2' : ''}
     ORDER BY created_at DESC`,
    productId ? [tenantId, productId] : [tenantId],
  );
  return rows;
}
