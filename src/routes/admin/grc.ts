// Authorized by HUB-1385 (E-CMP-WAVE4 S2, HUB-870) — GRC-Lite Wave 4 CRUD API.
// 11 admin endpoints for device inventory + HR lifecycle registers. Every mutating
// endpoint requires super_admin (portfolio-scope data, not tenant-scoped); GET
// endpoints require any authenticated operator (super_admin or product_admin).
//
// Signal emission (AC 5, 8, 11): compliance-positive events open a pg transaction,
// write the primary record, INSERT into compliance_signal_evidence via the shared
// emitGrcSignal helper, and COMMIT — atomic. Non-compliant device attestations
// (AC 13) INSERT the record without emitting.
//
// Deadline computation (schema reconciliation with HUB-1384):
//   - Onboarding: sla_deadline = hire_date + 7 days   (handler-computed)
//   - Offboarding: revocation_deadline = last_day + 24 h  (handler-computed)
//
// Soft delete (AC 4): migration 068 added `status` + `decommissioned_at` columns
// to device_inventory; DELETE toggles status='decommissioned' + timestamp.
//
// See the story description in HUB-1385 for the full endpoint contract; renames vs
// the story text (device_returned vs equipment_returned etc.) match the HUB-1384
// schema names as-shipped and are documented in the story's close-out comment.

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import { getPool } from '../../db/pool.js';
import { parsePagination } from '../../lib/pagination.js';
import { emitGrcSignal } from '../../services/grcSignalService.js';
import {
  hireDatePlusSlaDays,
  lastDayPlusRevocationHours,
  controlKeyForComplianceType,
  CONTROL_KEY_HR_ONBOARDING,
  CONTROL_KEY_HR_OFFBOARDING,
} from '../../services/grcRegisterService.js';
import {
  SIGNAL_DEVICE_COMPLIANCE_ATTESTED,
  SIGNAL_HR_ONBOARDING_COMPLETED,
  SIGNAL_HR_OFFBOARDING_COMPLETED,
} from '../../compliance/signalTypes.js';
import type {
  DeviceComplianceType,
  DeviceComplianceStatus,
} from '../../compliance/grcTypes.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_COMPLIANCE_TYPES: ReadonlySet<DeviceComplianceType> = new Set([
  'mdm_enrollment',
  'disk_encryption',
  'screen_lock',
]);
const VALID_COMPLIANCE_STATUSES: ReadonlySet<DeviceComplianceStatus> = new Set([
  'compliant',
  'non_compliant',
  'pending_verification',
]);
const VALID_DEVICE_STATUSES: ReadonlySet<string> = new Set(['active', 'decommissioned']);

function assertOperator(request: FastifyRequest): void {
  if (!request.operatorUser) throw new AppError(401, 'Unauthenticated');
}

function assertSuperAdmin(request: FastifyRequest): void {
  assertOperator(request);
  if (request.operatorUser!.role !== 'super_admin') {
    throw new AppError(403, 'super_admin role required');
  }
}

function assertUuidParam(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw new AppError(400, 'invalid id: expected UUID');
  }
}

function requireString(body: Record<string, unknown>, field: string): string {
  const v = body[field];
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new AppError(400, `missing required field: ${field}`);
  }
  return v;
}

function optionalString(body: Record<string, unknown>, field: string): string | null {
  const v = body[field];
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new AppError(400, `field ${field} must be a string`);
  return v;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Route plugin
// ─────────────────────────────────────────────────────────────────────────────

const adminGrcRoutes: FastifyPluginAsync = async (fastify) => {
  // ── Devices ─────────────────────────────────────────────────────────────

  fastify.post('/api/v1/admin/grc/devices', async (request, reply) => {
    assertSuperAdmin(request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const product_id = requireString(body, 'product_id');
    const device_name = requireString(body, 'device_name');
    const owner_name = requireString(body, 'owner_name');
    const owner_email = requireString(body, 'owner_email');
    const model = optionalString(body, 'model');
    const serial_number = optionalString(body, 'serial_number');
    const enrollment_date = optionalString(body, 'enrollment_date');

    const { rows } = await getPool().query(
      `INSERT INTO device_inventory
         (product_id, device_name, owner_name, owner_email, model, serial_number, enrollment_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [product_id, device_name, owner_name, owner_email, model, serial_number, enrollment_date],
    );
    return reply.status(201).send(rows[0]);
  });

  fastify.get('/api/v1/admin/grc/devices', async (request) => {
    assertOperator(request);
    const q = (request.query ?? {}) as Record<string, unknown>;
    const { page, pageSize, limit, offset } = parsePagination(q);

    const statusFilter = typeof q.status === 'string' && VALID_DEVICE_STATUSES.has(q.status)
      ? (q.status as string)
      : null;

    const conditions: string[] = [];
    const params: unknown[] = [];
    if (statusFilter) {
      params.push(statusFilter);
      conditions.push(`status = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows: totalRows } = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM device_inventory ${where}`,
      params,
    );
    const total = parseInt(totalRows[0]!.count, 10);

    params.push(limit, offset);
    const { rows: data } = await getPool().query(
      `SELECT * FROM device_inventory ${where}
        ORDER BY added_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { data, total, page, pageSize };
  });

  fastify.put('/api/v1/admin/grc/devices/:id', async (request) => {
    assertSuperAdmin(request);
    const params = request.params as { id?: unknown };
    assertUuidParam(params.id);
    const body = (request.body ?? {}) as Record<string, unknown>;

    // Only allow updating the mutable fields; explicitly ignore id / added_at / status /
    // decommissioned_at (status transitions live on the DELETE route).
    const fields = ['device_name', 'owner_name', 'owner_email', 'model', 'serial_number', 'enrollment_date'];
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const f of fields) {
      if (Object.prototype.hasOwnProperty.call(body, f)) {
        values.push(body[f]);
        sets.push(`${f} = $${values.length}`);
      }
    }
    if (sets.length === 0) throw new AppError(400, 'no updatable fields provided');
    sets.push(`updated_at = NOW()`);

    values.push(params.id);
    const { rows } = await getPool().query(
      `UPDATE device_inventory SET ${sets.join(', ')}
        WHERE id = $${values.length}
        RETURNING *`,
      values,
    );
    if (rows.length === 0) throw new AppError(404, 'device not found');
    return rows[0];
  });

  fastify.delete('/api/v1/admin/grc/devices/:id', async (request) => {
    assertSuperAdmin(request);
    const params = request.params as { id?: unknown };
    assertUuidParam(params.id);

    const { rows } = await getPool().query<{ id: string; decommissioned_at: string }>(
      `UPDATE device_inventory
          SET status = 'decommissioned', decommissioned_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND status = 'active'
        RETURNING id, decommissioned_at`,
      [params.id],
    );
    if (rows.length === 0) {
      // Distinguish 404 from already-decommissioned (409) for operator clarity.
      const { rows: exists } = await getPool().query<{ status: string }>(
        `SELECT status FROM device_inventory WHERE id = $1`,
        [params.id],
      );
      if (exists.length === 0) throw new AppError(404, 'device not found');
      throw new AppError(409, 'device already decommissioned');
    }
    return { id: rows[0]!.id, decommissioned_at: rows[0]!.decommissioned_at };
  });

  // ── Device compliance attestation ────────────────────────────────────────

  fastify.post('/api/v1/admin/grc/devices/:id/compliance', async (request, reply) => {
    assertSuperAdmin(request);
    const params = request.params as { id?: unknown };
    assertUuidParam(params.id);
    const body = (request.body ?? {}) as Record<string, unknown>;

    const compliance_type = requireString(body, 'compliance_type') as DeviceComplianceType;
    if (!VALID_COMPLIANCE_TYPES.has(compliance_type)) {
      throw new AppError(400, `invalid compliance_type: ${compliance_type}`);
    }
    const status = requireString(body, 'status') as DeviceComplianceStatus;
    if (!VALID_COMPLIANCE_STATUSES.has(status)) {
      throw new AppError(400, `invalid status: ${status}`);
    }
    const attested_by = requireString(body, 'attested_by');

    const client = await getPool().connect();
    try {
      await client.query('BEGIN');

      const { rows: deviceRows } = await client.query<{ product_id: string }>(
        `SELECT product_id FROM device_inventory WHERE id = $1 FOR UPDATE`,
        [params.id],
      );
      if (deviceRows.length === 0) {
        await client.query('ROLLBACK');
        throw new AppError(404, 'device not found');
      }
      const productSlug = deviceRows[0]!.product_id;

      const { rows: recordRows } = await client.query<{ id: string; attested_at: string; content_hash: string }>(
        `INSERT INTO device_compliance_records (device_id, compliance_type, status, attested_by)
         VALUES ($1, $2, $3, $4)
         RETURNING id, attested_at, content_hash`,
        [params.id, compliance_type, status, attested_by],
      );
      const record = recordRows[0]!;

      // AC 13: only compliant attestations emit a signal.
      if (status === 'compliant') {
        await emitGrcSignal(client, {
          productSlug,
          controlKey: controlKeyForComplianceType(compliance_type),
          signalType: SIGNAL_DEVICE_COMPLIANCE_ATTESTED,
          entityId: record.id,
          payload: {
            device_id: params.id,
            compliance_type,
            attested_by,
          },
          observedAt: new Date(record.attested_at),
        });
      }

      await client.query('COMMIT');
      return reply.status(201).send({
        id: record.id,
        device_id: params.id,
        compliance_type,
        status,
        attested_by,
        attested_at: record.attested_at,
        content_hash: record.content_hash,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  });

  // ── Onboarding ──────────────────────────────────────────────────────────

  fastify.post('/api/v1/admin/grc/onboarding', async (request, reply) => {
    assertSuperAdmin(request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const product_id = requireString(body, 'product_id');
    const employee_name = requireString(body, 'employee_name');
    const employee_email = requireString(body, 'employee_email');
    const role = requireString(body, 'role');
    const hire_date = requireString(body, 'hire_date');
    const sla_deadline = hireDatePlusSlaDays(hire_date);

    const { rows } = await getPool().query(
      `INSERT INTO hr_onboarding_records
         (product_id, employee_name, employee_email, role, hire_date, sla_deadline)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [product_id, employee_name, employee_email, role, hire_date, sla_deadline],
    );
    return reply.status(201).send(rows[0]);
  });

  fastify.get('/api/v1/admin/grc/onboarding', async (request) => {
    assertOperator(request);
    const q = (request.query ?? {}) as Record<string, unknown>;
    const { page, pageSize, limit, offset } = parsePagination(q);
    const statusFilter = typeof q.status === 'string' ? q.status : null;

    const conditions: string[] = [];
    const params: unknown[] = [];
    if (statusFilter) {
      params.push(statusFilter);
      conditions.push(`status = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows: totalRows } = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM hr_onboarding_records ${where}`,
      params,
    );
    const total = parseInt(totalRows[0]!.count, 10);

    params.push(limit, offset);
    const { rows: data } = await getPool().query(
      `SELECT * FROM hr_onboarding_records ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { data, total, page, pageSize };
  });

  fastify.post('/api/v1/admin/grc/onboarding/:id/complete', async (request) => {
    assertSuperAdmin(request);
    const params = request.params as { id?: unknown };
    assertUuidParam(params.id);
    const attester = request.operatorUser!.operator_id;

    const client = await getPool().connect();
    try {
      await client.query('BEGIN');

      const { rows: existing } = await client.query<{ product_id: string; status: string; completed_at: string | null }>(
        `SELECT product_id, status, completed_at
           FROM hr_onboarding_records WHERE id = $1 FOR UPDATE`,
        [params.id],
      );
      if (existing.length === 0) {
        await client.query('ROLLBACK');
        throw new AppError(404, 'onboarding record not found');
      }
      const record = existing[0]!;
      if (record.completed_at !== null) {
        await client.query('ROLLBACK');
        throw new AppError(409, 'onboarding record already completed');
      }

      const { rows: updated } = await client.query(
        `UPDATE hr_onboarding_records
            SET status = 'completed',
                completed_at = NOW(),
                attested_by = $2,
                updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [params.id, attester],
      );
      const row = updated[0]!;

      await emitGrcSignal(client, {
        productSlug: record.product_id,
        controlKey: CONTROL_KEY_HR_ONBOARDING,
        signalType: SIGNAL_HR_ONBOARDING_COMPLETED,
        entityId: params.id,
        payload: {
          onboarding_record_id: params.id,
          attested_by: attester,
        },
        observedAt: new Date(row.completed_at as string),
      });

      await client.query('COMMIT');
      return row;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  });

  // ── Offboarding ─────────────────────────────────────────────────────────

  fastify.post('/api/v1/admin/grc/offboarding', async (request, reply) => {
    assertSuperAdmin(request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const product_id = requireString(body, 'product_id');
    const employee_name = requireString(body, 'employee_name');
    const employee_email = requireString(body, 'employee_email');
    const role = requireString(body, 'role');
    const last_day = requireString(body, 'last_day');
    const revocation_deadline = lastDayPlusRevocationHours(last_day);

    const { rows } = await getPool().query(
      `INSERT INTO hr_offboarding_records
         (product_id, employee_name, employee_email, role, last_day, revocation_deadline)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [product_id, employee_name, employee_email, role, last_day, revocation_deadline],
    );
    return reply.status(201).send(rows[0]);
  });

  fastify.get('/api/v1/admin/grc/offboarding', async (request) => {
    assertOperator(request);
    const q = (request.query ?? {}) as Record<string, unknown>;
    const { page, pageSize, limit, offset } = parsePagination(q);
    const statusFilter = typeof q.status === 'string' ? q.status : null;

    const conditions: string[] = [];
    const params: unknown[] = [];
    if (statusFilter) {
      params.push(statusFilter);
      conditions.push(`status = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows: totalRows } = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM hr_offboarding_records ${where}`,
      params,
    );
    const total = parseInt(totalRows[0]!.count, 10);

    params.push(limit, offset);
    const { rows: data } = await getPool().query(
      `SELECT * FROM hr_offboarding_records ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { data, total, page, pageSize };
  });

  fastify.put('/api/v1/admin/grc/offboarding/:id/checklist', async (request) => {
    assertSuperAdmin(request);
    const params = request.params as { id?: unknown };
    assertUuidParam(params.id);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const attester = request.operatorUser!.operator_id;

    // Story text uses equipment_returned / accounts_deprovisioned / documentation_complete;
    // HUB-1384 schema (as-shipped) uses device_returned / accounts_disabled / tokens_revoked.
    // Accepting the schema names — see HUB-1385 close-out comment for the reconciliation.
    const fields = ['device_returned', 'accounts_disabled', 'tokens_revoked'] as const;
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const f of fields) {
      if (Object.prototype.hasOwnProperty.call(body, f)) {
        if (typeof body[f] !== 'boolean') throw new AppError(400, `field ${f} must be boolean`);
        values.push(body[f]);
        sets.push(`${f} = $${values.length}`);
      }
    }
    if (sets.length === 0) throw new AppError(400, 'no checklist fields provided');

    const client = await getPool().connect();
    try {
      await client.query('BEGIN');

      const { rows: existing } = await client.query<{
        product_id: string;
        completed_at: string | null;
        device_returned: boolean;
        accounts_disabled: boolean;
        tokens_revoked: boolean;
      }>(
        `SELECT product_id, completed_at, device_returned, accounts_disabled, tokens_revoked
           FROM hr_offboarding_records WHERE id = $1 FOR UPDATE`,
        [params.id],
      );
      if (existing.length === 0) {
        await client.query('ROLLBACK');
        throw new AppError(404, 'offboarding record not found');
      }
      const before = existing[0]!;

      values.push(params.id);
      sets.push('updated_at = NOW()');
      const { rows: updated } = await client.query<{
        id: string;
        product_id: string;
        device_returned: boolean;
        accounts_disabled: boolean;
        tokens_revoked: boolean;
        completed_at: string | null;
      }>(
        `UPDATE hr_offboarding_records SET ${sets.join(', ')}
          WHERE id = $${values.length}
          RETURNING *`,
        values,
      );
      const after = updated[0]!;

      const allRevoked = after.device_returned && after.accounts_disabled && after.tokens_revoked;
      let finalRow: typeof after = after;
      if (allRevoked && before.completed_at === null) {
        // Auto-complete + emit signal within the same transaction.
        const { rows: completed } = await client.query<typeof after>(
          `UPDATE hr_offboarding_records
              SET status = 'completed',
                  completed_at = NOW(),
                  attested_by = $2,
                  updated_at = NOW()
            WHERE id = $1
            RETURNING *`,
          [params.id, attester],
        );
        finalRow = completed[0]!;

        await emitGrcSignal(client, {
          productSlug: after.product_id,
          controlKey: CONTROL_KEY_HR_OFFBOARDING,
          signalType: SIGNAL_HR_OFFBOARDING_COMPLETED,
          entityId: params.id,
          payload: {
            offboarding_record_id: params.id,
            attested_by: attester,
          },
          observedAt: new Date(finalRow.completed_at as string),
        });
      }

      await client.query('COMMIT');
      return finalRow;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  });
};

export default adminGrcRoutes;
