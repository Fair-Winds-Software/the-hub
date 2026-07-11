// Authorized by HUB-1686 (E-FE-13 S1) — Failed Payment Tracker BE route.
// Five admin endpoints for the FE surface (HUB-1568):
//
//   GET  /api/v1/admin/billing/failed-payments
//        ?status=&productId=&from=&to=&limit=&offset=&fresh=
//   GET  /api/v1/admin/billing/failed-payments/:id
//   POST /api/v1/admin/billing/failed-payments/:id/retry
//   POST /api/v1/admin/billing/failed-payments/:id/override    (reason ≥20 chars)
//   POST /api/v1/admin/billing/failed-payments/bulk-email       (super_admin only)
//
// RBAC (server-authoritative, defense-in-depth):
//   - super_admin: all invoices, all actions.
//   - product_admin: scoped to their tenant (D-HUB-SCOPE-035 v0.1 lock —
//     same tenant_id single-tenant rule the rest of the console uses,
//     NOT the aspirational scoped_products[] JWT claim the story spec
//     references). Bulk-email → 403 for product_admin.
//     "404 not 403" for out-of-scope invoice reads (drill-in / retry /
//     override) — avoids leaking the existence of out-of-scope rows.
//
// Idempotency contract for /retry (HUB-1568 §9 highest-impact invariant):
//   If invoices.last_retry_triggered_at > now() - 30s → return 409
//     { error: 'retry_in_flight', message, nextRetryAt }.
//   Otherwise: call stripeService.retryInvoicePayment + increment
//   attempt_count + set last_retry_triggered_at.
//
// hub_state is DERIVED from stored columns at read time:
//   overridden_at IS NOT NULL                                  → 'overridden'
//   amount_paid >= amount_due AND payment_failed_at IS NOT NULL → 'recovered'
//   attempt_count >= max_attempts                              → 'exhausted'
//   payment_failed_at IS NOT NULL                              → 'pending_retry'
// (See migration 066 header for the "no stored hub_state" rationale —
// single source of truth stays in the SELECT.)
//
// Spec deviations (per ironclad-engineer):
//   1. RBAC — story spec used scoped_products[] JWT claim; codebase
//      D-HUB-SCOPE-035 v0.1 lock forbids that. Falls back to tenant_id
//      single-tenant match. Same pattern documented in HUB-1680.
//   2. Retry mechanism — story spec suggested re-enqueueing on
//      billing_payment_failed queue; v0.1 calls stripeService
//      .retryInvoicePayment directly (Stripe SDK invoices.pay). The
//      queue-re-enqueue pattern would require a new "operator-triggered"
//      job type that doesn't exist; the direct call keeps the surface
//      small and observable, and Stripe's own idempotency handles
//      already-paid invoices.
//   3. Bulk-email template — story spec named "standard payment retry
//      template" from E-FE-6; the notification-channel system doesn't
//      expose a per-purpose template registry at v0.1. Inline template
//      literal here with tenant + amount interpolation; template lives
//      in this file so ops can review it before adding template-store
//      infra in v0.2.

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import { getPool } from '../../db/pool.js';
import { retryInvoicePayment } from '../../services/stripeService.js';
import { sendEmail } from '../../services/notifications/emailHandler.js';
import { writeAuditEntry } from '../../services/auditLogService.js';

const CACHE_TTL_MS = 60_000;
const RETRY_IN_FLIGHT_WINDOW_MS = 30_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const OVERRIDE_REASON_MIN_CHARS = 20;
const BULK_EMAIL_MAX_RECIPIENTS = 50;

const HUB_INTERNAL_TENANT_ID = '00000000-0000-0000-0000-000000000001';

export type FailedPaymentStatus =
  | 'pending_retry'
  | 'exhausted'
  | 'recovered'
  | 'overridden';

const VALID_STATUSES: ReadonlySet<string> = new Set<FailedPaymentStatus>([
  'pending_retry',
  'exhausted',
  'recovered',
  'overridden',
]);

interface FailedPaymentRow {
  id: string;
  invoiceId: string;
  tenantId: string;
  tenantName: string;
  productId: string;
  amountCents: number;
  currency: string;
  failureReason: string | null;
  attemptCount: number;
  maxAttempts: number;
  nextRetryAt: string | null;
  lastRetryTriggeredAt: string | null;
  status: FailedPaymentStatus;
  createdAt: string;
}

interface ListCacheEntry {
  key: string;
  computedAt: number;
  payload: { rows: FailedPaymentRow[]; total: number; generatedAt: string };
}

let listCache: ListCacheEntry | null = null;

export function _resetFailedPaymentsCache(): void {
  listCache = null;
}

const HUB_STATE_SQL = `CASE
    WHEN i.overridden_at IS NOT NULL                              THEN 'overridden'
    WHEN i.amount_paid >= i.amount_due AND i.payment_failed_at IS NOT NULL THEN 'recovered'
    WHEN i.attempt_count >= i.max_attempts                        THEN 'exhausted'
    WHEN i.payment_failed_at IS NOT NULL                          THEN 'pending_retry'
    ELSE 'active'
  END`;

async function assertOperator(request: FastifyRequest): Promise<void> {
  if (!request.operatorUser) throw new AppError(401, 'Unauthenticated');
}

function isSuperAdmin(request: FastifyRequest): boolean {
  return request.operatorUser?.role === 'super_admin';
}

function isFreshRequested(request: FastifyRequest): boolean {
  const q = request.query as Record<string, string | undefined>;
  return q.fresh === 'true' || q.fresh === '1';
}

async function fetchInvoiceRow(
  invoiceId: string,
  request: FastifyRequest,
): Promise<Record<string, unknown> | null> {
  const op = request.operatorUser!;
  const pool = getPool();
  const conditions: string[] = ['i.id = $1', 'i.payment_failed_at IS NOT NULL'];
  const params: unknown[] = [invoiceId];
  let idx = 2;
  if (op.role === 'product_admin') {
    conditions.push(`i.tenant_id = $${idx++}`);
    params.push(op.tenant_id);
  }
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT i.*, t.name AS tenant_name, ${HUB_STATE_SQL} AS hub_state
       FROM invoices i
       JOIN tenants t ON t.id = i.tenant_id
      WHERE ${conditions.join(' AND ')}`,
    params,
  );
  return rows[0] ?? null;
}

async function computeList(
  request: FastifyRequest,
  filters: {
    statuses: FailedPaymentStatus[];
    productId: string | null;
    from: Date;
    to: Date;
  },
): Promise<ListCacheEntry['payload']> {
  const op = request.operatorUser!;
  const pool = getPool();
  const conditions: string[] = ['i.payment_failed_at IS NOT NULL'];
  const params: unknown[] = [];
  let idx = 1;
  if (op.role === 'product_admin') {
    conditions.push(`i.tenant_id = $${idx++}`);
    params.push(op.tenant_id);
  }
  if (filters.productId) {
    conditions.push(`i.product_id = $${idx++}`);
    params.push(filters.productId);
  }
  conditions.push(`i.payment_failed_at >= $${idx++}`);
  params.push(filters.from);
  conditions.push(`i.payment_failed_at <= $${idx++}`);
  params.push(filters.to);

  // Status filter is applied post-derivation via a wrapping SELECT.
  const statusFilterSql =
    filters.statuses.length > 0
      ? `AND hub_state = ANY($${idx++}::text[])`
      : '';
  if (filters.statuses.length > 0) params.push(filters.statuses);

  const { rows } = await pool.query<{
    id: string;
    stripe_invoice_id: string;
    tenant_id: string;
    tenant_name: string;
    product_id: string;
    amount_due: number;
    currency: string;
    attempt_count: number;
    max_attempts: number;
    next_retry_at: Date | null;
    last_retry_triggered_at: Date | null;
    hub_state: FailedPaymentStatus;
    created_at: Date;
    delta_data: Record<string, unknown> | null;
  }>(
    `SELECT sub.* FROM (
       SELECT i.id, i.stripe_invoice_id, i.tenant_id, t.name AS tenant_name,
              i.product_id::text AS product_id, i.amount_due, i.currency,
              i.attempt_count, i.max_attempts, i.next_retry_at,
              i.last_retry_triggered_at, i.created_at, i.delta_data,
              ${HUB_STATE_SQL} AS hub_state
         FROM invoices i
         JOIN tenants t ON t.id = i.tenant_id
        WHERE ${conditions.join(' AND ')}
     ) sub
     WHERE 1=1 ${statusFilterSql}
     ORDER BY sub.created_at DESC`,
    params,
  );

  return {
    rows: rows.map<FailedPaymentRow>((r) => ({
      id: r.id,
      invoiceId: r.stripe_invoice_id,
      tenantId: r.tenant_id,
      tenantName: r.tenant_name,
      productId: r.product_id,
      amountCents: r.amount_due,
      currency: r.currency,
      failureReason:
        (r.delta_data as { failureReason?: string } | null)?.failureReason ??
        null,
      attemptCount: r.attempt_count,
      maxAttempts: r.max_attempts,
      nextRetryAt: r.next_retry_at ? r.next_retry_at.toISOString() : null,
      lastRetryTriggeredAt: r.last_retry_triggered_at
        ? r.last_retry_triggered_at.toISOString()
        : null,
      status: r.hub_state,
      createdAt: r.created_at.toISOString(),
    })),
    total: rows.length,
    generatedAt: new Date().toISOString(),
  };
}

const adminFailedPaymentsRoutes: FastifyPluginAsync = async (fastify) => {
  // ── List ─────────────────────────────────────────────────────────────
  // HUB-1772: handler self-scopes via op.tenant_id; no URL/body/query tenant_id required.
  fastify.get(
    '/api/v1/admin/billing/failed-payments',
    { config: { operatorSelfScoped: true } },
    async (request, reply) => {
      await assertOperator(request);
      const q = request.query as Record<string, string | undefined>;
      const statuses = (q.status ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s): s is FailedPaymentStatus => VALID_STATUSES.has(s));
      const productId = q.productId ?? null;
      const to = q.to ? new Date(q.to) : new Date();
      const from = q.from
        ? new Date(q.from)
        : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
      const limit = Math.min(
        MAX_LIMIT,
        Math.max(1, parseInt(q.limit ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT),
      );
      const offset = Math.max(0, parseInt(q.offset ?? '0', 10) || 0);

      // Cache-key window: use the explicit query strings when passed so
      // caller-provided ranges get distinct entries; otherwise a fixed
      // "default-30d" bucket so back-to-back default calls share a
      // cache entry within the TTL (would-be-broken otherwise because
      // `new Date()` moves).
      const op = request.operatorUser!;
      const cacheKey = [
        op.role === 'super_admin' ? 'all' : `t:${op.tenant_id ?? 'none'}`,
        `p:${productId ?? '*'}`,
        `s:${statuses.slice().sort().join(',')}`,
        `f:${q.from ?? 'default-30d'}`,
        `t:${q.to ?? 'now'}`,
      ].join('|');

      let payload: ListCacheEntry['payload'];
      const now = Date.now();
      if (
        !isFreshRequested(request) &&
        listCache &&
        listCache.key === cacheKey &&
        now - listCache.computedAt < CACHE_TTL_MS
      ) {
        payload = listCache.payload;
      } else {
        payload = await computeList(request, {
          statuses,
          productId,
          from,
          to,
        });
        listCache = { key: cacheKey, computedAt: now, payload };
      }

      return reply.send({
        rows: payload.rows.slice(offset, offset + limit),
        total: payload.total,
        generatedAt: payload.generatedAt,
      });
    },
  );

  // ── Drill-in ─────────────────────────────────────────────────────────
  fastify.get(
    '/api/v1/admin/billing/failed-payments/:id',
    async (request, reply) => {
      await assertOperator(request);
      const params = request.params as { id: string };
      const row = await fetchInvoiceRow(params.id, request);
      // 404 not 403 per Epic AC #3 — avoids leaking the existence of
      // out-of-scope rows.
      if (!row) throw new AppError(404, 'Failed payment not found');
      const pool = getPool();
      const { rows: history } = await pool.query<{
        received_at: Date;
        raw_event: { data?: { object?: { last_payment_error?: { decline_code?: string; message?: string } } } };
      }>(
        `SELECT received_at, raw_event
           FROM stripe_webhook_events
          WHERE product_id = $1::text
            AND event_type = 'invoice.payment_failed'
          ORDER BY received_at DESC
          LIMIT 20`,
        [row.product_id],
      );
      return reply.send({
        id: row.id,
        invoiceId: row.stripe_invoice_id,
        stripeSubscriptionId: row.stripe_subscription_id,
        tenantId: row.tenant_id,
        tenantName: row.tenant_name,
        productId: row.product_id,
        amountCents: row.amount_due,
        currency: row.currency,
        attemptCount: row.attempt_count,
        maxAttempts: row.max_attempts,
        nextRetryAt: row.next_retry_at
          ? (row.next_retry_at as Date).toISOString()
          : null,
        lastRetryTriggeredAt: row.last_retry_triggered_at
          ? (row.last_retry_triggered_at as Date).toISOString()
          : null,
        status: row.hub_state,
        overriddenAt: row.overridden_at
          ? (row.overridden_at as Date).toISOString()
          : null,
        overriddenBy: row.overridden_by,
        overrideReason: row.override_reason,
        retryHistory: history.map((h) => ({
          attemptAt: h.received_at.toISOString(),
          declineCode:
            h.raw_event?.data?.object?.last_payment_error?.decline_code ?? null,
          errorMessage:
            h.raw_event?.data?.object?.last_payment_error?.message ?? null,
        })),
      });
    },
  );

  // ── Retry ────────────────────────────────────────────────────────────
  fastify.post(
    '/api/v1/admin/billing/failed-payments/:id/retry',
    async (request, reply) => {
      await assertOperator(request);
      const op = request.operatorUser!;
      const params = request.params as { id: string };
      const row = await fetchInvoiceRow(params.id, request);
      if (!row) throw new AppError(404, 'Failed payment not found');

      // Idempotency guard: any retry triggered in the last 30 seconds
      // → 409, even if the caller is a different operator.
      const lastTriggered = row.last_retry_triggered_at as Date | null;
      const now = new Date();
      if (
        lastTriggered &&
        now.getTime() - lastTriggered.getTime() < RETRY_IN_FLIGHT_WINDOW_MS
      ) {
        return reply.status(409).send({
          error: 'retry_in_flight',
          message:
            'A retry is already pending for this invoice. Please wait.',
          nextRetryAt: lastTriggered.toISOString(),
        });
      }

      const stripeInvoiceId = row.stripe_invoice_id as string;
      const result = await retryInvoicePayment(stripeInvoiceId);

      const pool = getPool();
      const { rows: updated } = await pool.query<{
        attempt_count: number;
        last_retry_triggered_at: Date;
      }>(
        `UPDATE invoices
            SET attempt_count = attempt_count + 1,
                last_retry_triggered_at = NOW()
          WHERE id = $1
      RETURNING attempt_count, last_retry_triggered_at`,
        [row.id],
      );

      await writeAuditEntry({
        tenant_id: row.tenant_id as string,
        product_id: row.product_id as string,
        actor_id: op.operator_id,
        actor_type: 'operator',
        operation: 'UPDATE',
        table_name: 'invoices',
        record_id: row.id as string,
        event_type: null,
        severity: 'info',
        new_values: {
          action: 'payment_retry_triggered',
          attemptCount: updated[0]!.attempt_count,
          stripeResult: result,
        },
      });

      _resetFailedPaymentsCache();

      return reply.status(202).send({
        attemptCount: updated[0]!.attempt_count,
        lastRetryTriggeredAt:
          updated[0]!.last_retry_triggered_at.toISOString(),
        stripeStatus: result.status,
      });
    },
  );

  // ── Override ─────────────────────────────────────────────────────────
  fastify.post(
    '/api/v1/admin/billing/failed-payments/:id/override',
    async (request, reply) => {
      await assertOperator(request);
      const op = request.operatorUser!;
      const params = request.params as { id: string };
      const body = (request.body ?? {}) as { reason?: string };
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (reason.length < OVERRIDE_REASON_MIN_CHARS) {
        return reply.status(422).send({
          error: 'override_reason_too_short',
          message: `Override reason must be at least ${OVERRIDE_REASON_MIN_CHARS} characters.`,
          providedLength: reason.length,
        });
      }
      const row = await fetchInvoiceRow(params.id, request);
      if (!row) throw new AppError(404, 'Failed payment not found');

      const pool = getPool();
      const { rows: updated } = await pool.query<{
        overridden_at: Date;
      }>(
        `UPDATE invoices
            SET overridden_at = NOW(),
                overridden_by = $2,
                override_reason = $3
          WHERE id = $1 AND overridden_at IS NULL
      RETURNING overridden_at`,
        [row.id, op.operator_id, reason],
      );

      if (updated.length === 0) {
        // Already overridden — surface 409 rather than silently accept.
        return reply.status(409).send({
          error: 'already_overridden',
          message: 'This invoice has already been overridden.',
        });
      }

      await writeAuditEntry({
        tenant_id: row.tenant_id as string,
        product_id: row.product_id as string,
        actor_id: op.operator_id,
        actor_type: 'operator',
        operation: 'UPDATE',
        table_name: 'invoices',
        record_id: row.id as string,
        event_type: null,
        severity: 'warn',
        new_values: {
          action: 'payment_override',
          reason,
          overriddenAt: updated[0]!.overridden_at.toISOString(),
        },
      });

      _resetFailedPaymentsCache();

      return reply.status(200).send({
        overriddenAt: updated[0]!.overridden_at.toISOString(),
        overriddenBy: op.operator_id,
      });
    },
  );

  // ── Bulk email (super_admin only) ────────────────────────────────────
  fastify.post(
    '/api/v1/admin/billing/failed-payments/bulk-email',
    async (request, reply) => {
      await assertOperator(request);
      if (!isSuperAdmin(request)) {
        throw new AppError(403, 'super_admin required for bulk-email');
      }
      const body = (request.body ?? {}) as { ids?: string[] };
      const ids = Array.isArray(body.ids) ? body.ids : [];
      if (ids.length === 0) throw new AppError(400, 'ids array is required');
      if (ids.length > BULK_EMAIL_MAX_RECIPIENTS) {
        return reply.status(422).send({
          error: 'too_many_recipients',
          message: `bulk-email accepts at most ${BULK_EMAIL_MAX_RECIPIENTS} recipients per call.`,
          providedCount: ids.length,
        });
      }

      const pool = getPool();
      const { rows: invoices } = await pool.query<{
        id: string;
        tenant_id: string;
        tenant_name: string;
        product_id: string;
        amount_due: number;
        currency: string;
        customer_email: string | null;
      }>(
        `SELECT i.id, i.tenant_id, t.name AS tenant_name,
                i.product_id::text AS product_id,
                i.amount_due, i.currency,
                (t.settings->>'billing_email')::text AS customer_email
           FROM invoices i
           JOIN tenants t ON t.id = i.tenant_id
          WHERE i.id = ANY($1::uuid[])
            AND i.payment_failed_at IS NOT NULL`,
        [ids],
      );

      let sent = 0;
      const failed: Array<{ id: string; error: string }> = [];
      for (const inv of invoices) {
        try {
          const email = inv.customer_email;
          if (!email) {
            failed.push({ id: inv.id, error: 'tenant has no billing_email configured' });
            continue;
          }
          await sendEmail({
            to: email,
            subject: `Payment retry — ${inv.tenant_name}`,
            body: [
              `Hi,`,
              ``,
              `A payment on your ${inv.tenant_name} account has failed and we would appreciate your attention.`,
              ``,
              `Amount: ${(inv.amount_due / 100).toFixed(2)} ${inv.currency.toUpperCase()}`,
              ``,
              `Please update your payment method or contact support to complete the payment.`,
              ``,
              `— The Fair Winds Software Team`,
            ].join('\n'),
          });
          sent += 1;
        } catch (err) {
          failed.push({
            id: inv.id,
            error: err instanceof Error ? err.message : 'send failed',
          });
        }
      }

      // Missing IDs (RBAC-scoped or non-failed) show up as unknown
      // failures rather than being silently dropped.
      const returnedIds = new Set(invoices.map((i) => i.id));
      for (const id of ids) {
        if (!returnedIds.has(id)) {
          failed.push({ id, error: 'invoice not found or not a failed payment' });
        }
      }

      await writeAuditEntry({
        tenant_id: HUB_INTERNAL_TENANT_ID,
        actor_id: request.operatorUser!.operator_id,
        actor_type: 'operator',
        operation: 'INSERT',
        table_name: 'invoices',
        event_type: null,
        severity: 'info',
        new_values: {
          action: 'payment_retry_bulk_email',
          requestedCount: ids.length,
          sentCount: sent,
          failedCount: failed.length,
        },
      });

      _resetFailedPaymentsCache();

      return reply.status(200).send({ sent, failed });
    },
  );
};

export default adminFailedPaymentsRoutes;
