// Authorized by HUB-1423 (E-CMP-WAVE4b S2, HUB-871) — GRC-Lite Wave 4b CRUD API.
// 13 admin endpoints for vendor / cloud infra / policy registers. Structural mirror of
// HUB-1385 grc.ts (device/HR triad); reuses emitGrcSignal + parsePagination + the
// super_admin gate pattern. All Wave 4b signals emit under the seeded `hub-portfolio`
// product (migration 070) since these registers are portfolio-scoped rather than
// per-product like device/HR.
//
// Signal emission (AC 5, 9, 13): compliance-positive events open a pg transaction,
// write the primary record, INSERT into compliance_signal_evidence via emitGrcSignal,
// and COMMIT — atomic. AC 14: cloud attestation with status='fail' or 'partial' INSERTs
// the record without emitting.
//
// Policy acknowledgment (AC 13): both super_admin AND product_admin may acknowledge —
// models employee self-service. All other mutations gate on super_admin.

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import { getPool } from '../../db/pool.js';
import { parsePagination } from '../../lib/pagination.js';
import { emitGrcSignal } from '../../services/grcSignalService.js';
import {
  SIGNAL_VENDOR_RISK_ASSESSED,
  SIGNAL_CLOUD_SECURITY_ATTESTED,
  SIGNAL_POLICY_ACKNOWLEDGED,
} from '../../compliance/signalTypes.js';
import type {
  CloudAttestationStatus,
  CloudProvider,
  PolicyType,
  VendorType,
} from '../../compliance/vendorCloudPolicyTypes.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// All Wave 4b signals route through the seeded portfolio product (migration 070).
const PORTFOLIO_PRODUCT_SLUG = 'hub-portfolio';

// Compliance control_id keys per migration 069.
const CONTROL_KEY_VENDOR_RISK = 'vendor-risk-review';
const CONTROL_KEY_CLOUD_SECURITY = 'cloud-security-audit';
const CONTROL_KEY_POLICY_ACK = 'policy-acknowledgment';

const VALID_VENDOR_TYPES: ReadonlySet<VendorType> = new Set([
  'saas', 'infrastructure', 'professional_services', 'other',
]);
const VALID_CLOUD_PROVIDERS: ReadonlySet<CloudProvider> = new Set(['aws', 'gcp', 'azure', 'other']);
const VALID_ATTESTATION_STATUSES: ReadonlySet<CloudAttestationStatus> = new Set(['pass', 'fail', 'partial']);
const VALID_POLICY_TYPES: ReadonlySet<PolicyType> = new Set([
  'security', 'privacy', 'acceptable_use', 'incident_response', 'other',
]);
const VALID_REGISTER_STATUSES: ReadonlySet<string> = new Set(['active', 'archived']);

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
function optionalInt(body: Record<string, unknown>, field: string): number | null {
  const v = body[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new AppError(400, `field ${field} must be a number`);
  }
  return Math.trunc(v);
}

const adminGrcVendorCloudPolicyRoutes: FastifyPluginAsync = async (fastify) => {
  // ─────────────────────────────────────────────────────────────────────────
  //  Vendor register (AC 1-5)
  // ─────────────────────────────────────────────────────────────────────────

  fastify.post('/api/v1/admin/grc/vendors', async (request, reply) => {
    assertSuperAdmin(request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const vendor_name = requireString(body, 'vendor_name');
    const vendor_type = requireString(body, 'vendor_type');
    if (!VALID_VENDOR_TYPES.has(vendor_type as VendorType)) {
      throw new AppError(400, `invalid vendor_type: ${vendor_type}`);
    }
    const website = optionalString(body, 'website');
    const contract_start_date = optionalString(body, 'contract_start_date');
    const contract_end_date = optionalString(body, 'contract_end_date');
    const data_access_level = optionalString(body, 'data_access_level');
    const risk_level = optionalString(body, 'risk_level');
    const review_frequency_days = optionalInt(body, 'review_frequency_days') ?? 90;

    const { rows } = await getPool().query(
      `INSERT INTO vendor_register
         (vendor_name, vendor_type, website, contract_start_date, contract_end_date,
          data_access_level, risk_level, review_frequency_days)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [vendor_name, vendor_type, website, contract_start_date, contract_end_date,
        data_access_level, risk_level, review_frequency_days],
    );
    return reply.status(201).send(rows[0]);
  });

  fastify.get('/api/v1/admin/grc/vendors', async (request) => {
    assertOperator(request);
    const q = (request.query ?? {}) as Record<string, unknown>;
    const { page, pageSize, limit, offset } = parsePagination(q);
    const statusFilter =
      typeof q.status === 'string' && VALID_REGISTER_STATUSES.has(q.status) ? q.status : null;
    const riskFilter = typeof q.risk_level === 'string' ? q.risk_level : null;

    const conditions: string[] = [];
    const params: unknown[] = [];
    if (statusFilter) { params.push(statusFilter); conditions.push(`status = $${params.length}`); }
    if (riskFilter) { params.push(riskFilter); conditions.push(`risk_level = $${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows: totalRows } = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM vendor_register ${where}`, params,
    );
    const total = parseInt(totalRows[0]!.count, 10);

    params.push(limit, offset);
    const { rows: data } = await getPool().query(
      `SELECT * FROM vendor_register ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { data, total, page, pageSize };
  });

  fastify.put('/api/v1/admin/grc/vendors/:id', async (request) => {
    assertSuperAdmin(request);
    const params = request.params as { id?: unknown };
    assertUuidParam(params.id);
    const body = (request.body ?? {}) as Record<string, unknown>;

    const fields = [
      'vendor_name', 'vendor_type', 'website', 'contract_start_date', 'contract_end_date',
      'data_access_level', 'risk_level', 'review_frequency_days', 'last_reviewed_at',
      'next_review_due',
    ];
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const f of fields) {
      if (Object.prototype.hasOwnProperty.call(body, f)) {
        values.push(body[f]);
        sets.push(`${f} = $${values.length}`);
      }
    }
    if (sets.length === 0) throw new AppError(400, 'no updatable fields provided');
    sets.push('updated_at = NOW()');

    values.push(params.id);
    const { rows } = await getPool().query(
      `UPDATE vendor_register SET ${sets.join(', ')}
        WHERE id = $${values.length}
        RETURNING *`,
      values,
    );
    if (rows.length === 0) throw new AppError(404, 'vendor not found');
    return rows[0];
  });

  fastify.delete('/api/v1/admin/grc/vendors/:id', async (request) => {
    assertSuperAdmin(request);
    const params = request.params as { id?: unknown };
    assertUuidParam(params.id);
    const { rows } = await getPool().query<{ id: string; status: string; updated_at: string }>(
      `UPDATE vendor_register
          SET status = 'archived', updated_at = NOW()
        WHERE id = $1 AND status = 'active'
        RETURNING id, status, updated_at`,
      [params.id],
    );
    if (rows.length === 0) {
      const { rows: exists } = await getPool().query<{ status: string }>(
        `SELECT status FROM vendor_register WHERE id = $1`, [params.id],
      );
      if (exists.length === 0) throw new AppError(404, 'vendor not found');
      throw new AppError(409, 'vendor already archived');
    }
    return rows[0];
  });

  fastify.post('/api/v1/admin/grc/vendors/:id/assessment', async (request, reply) => {
    assertSuperAdmin(request);
    const params = request.params as { id?: unknown };
    assertUuidParam(params.id);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const risk_score = optionalInt(body, 'risk_score');
    if (risk_score === null) throw new AppError(400, 'missing required field: risk_score');
    if (risk_score < 0 || risk_score > 100) throw new AppError(400, 'risk_score must be 0-100');
    const assessed_by = requireString(body, 'assessed_by');
    const findings = optionalString(body, 'findings');

    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const { rows: vendorRows } = await client.query<{ id: string }>(
        `SELECT id FROM vendor_register WHERE id = $1 FOR UPDATE`, [params.id],
      );
      if (vendorRows.length === 0) {
        await client.query('ROLLBACK');
        throw new AppError(404, 'vendor not found');
      }

      const { rows: recordRows } = await client.query<{ id: string; created_at: string; content_hash: string }>(
        `INSERT INTO vendor_risk_assessments (vendor_id, risk_score, assessed_by, findings)
         VALUES ($1, $2, $3, $4)
         RETURNING id, created_at, content_hash`,
        [params.id, risk_score, assessed_by, findings],
      );
      const record = recordRows[0]!;

      await emitGrcSignal(client, {
        productSlug: PORTFOLIO_PRODUCT_SLUG,
        controlKey: CONTROL_KEY_VENDOR_RISK,
        signalType: SIGNAL_VENDOR_RISK_ASSESSED,
        entityId: record.id,
        payload: { vendor_id: params.id, risk_score, assessed_by },
        observedAt: new Date(record.created_at),
      });

      await client.query('COMMIT');
      return reply.status(201).send({
        id: record.id,
        vendor_id: params.id,
        risk_score,
        assessed_by,
        findings,
        content_hash: record.content_hash,
        created_at: record.created_at,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  //  Cloud infrastructure register (AC 6-9)
  // ─────────────────────────────────────────────────────────────────────────

  fastify.post('/api/v1/admin/grc/cloud', async (request, reply) => {
    assertSuperAdmin(request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const account_name = requireString(body, 'account_name');
    const provider = requireString(body, 'provider');
    if (!VALID_CLOUD_PROVIDERS.has(provider as CloudProvider)) {
      throw new AppError(400, `invalid provider: ${provider}`);
    }
    const account_id = optionalString(body, 'account_id');
    const environment = optionalString(body, 'environment');
    const service_type = optionalString(body, 'service_type');
    const owner_id = optionalString(body, 'owner_id');
    const audit_frequency_days = optionalInt(body, 'audit_frequency_days') ?? 90;

    const { rows } = await getPool().query(
      `INSERT INTO cloud_infrastructure
         (account_name, provider, account_id, environment, service_type, owner_id, audit_frequency_days)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [account_name, provider, account_id, environment, service_type, owner_id, audit_frequency_days],
    );
    return reply.status(201).send(rows[0]);
  });

  fastify.get('/api/v1/admin/grc/cloud', async (request) => {
    assertOperator(request);
    const q = (request.query ?? {}) as Record<string, unknown>;
    const { page, pageSize, limit, offset } = parsePagination(q);
    const providerFilter = typeof q.provider === 'string' ? q.provider : null;
    const envFilter = typeof q.environment === 'string' ? q.environment : null;
    const statusFilter =
      typeof q.status === 'string' && VALID_REGISTER_STATUSES.has(q.status) ? q.status : null;

    const conditions: string[] = [];
    const params: unknown[] = [];
    if (providerFilter) { params.push(providerFilter); conditions.push(`provider = $${params.length}`); }
    if (envFilter) { params.push(envFilter); conditions.push(`environment = $${params.length}`); }
    if (statusFilter) { params.push(statusFilter); conditions.push(`status = $${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows: totalRows } = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM cloud_infrastructure ${where}`, params,
    );
    const total = parseInt(totalRows[0]!.count, 10);

    params.push(limit, offset);
    const { rows: data } = await getPool().query(
      `SELECT * FROM cloud_infrastructure ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { data, total, page, pageSize };
  });

  fastify.put('/api/v1/admin/grc/cloud/:id', async (request) => {
    assertSuperAdmin(request);
    const params = request.params as { id?: unknown };
    assertUuidParam(params.id);
    const body = (request.body ?? {}) as Record<string, unknown>;

    const fields = [
      'account_name', 'provider', 'account_id', 'environment', 'service_type',
      'owner_id', 'security_score', 'last_audited_at', 'next_audit_due',
      'audit_frequency_days',
    ];
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const f of fields) {
      if (Object.prototype.hasOwnProperty.call(body, f)) {
        values.push(body[f]);
        sets.push(`${f} = $${values.length}`);
      }
    }
    if (sets.length === 0) throw new AppError(400, 'no updatable fields provided');
    sets.push('updated_at = NOW()');
    values.push(params.id);
    const { rows } = await getPool().query(
      `UPDATE cloud_infrastructure SET ${sets.join(', ')}
        WHERE id = $${values.length}
        RETURNING *`,
      values,
    );
    if (rows.length === 0) throw new AppError(404, 'cloud account not found');
    return rows[0];
  });

  fastify.post('/api/v1/admin/grc/cloud/:id/attestation', async (request, reply) => {
    assertSuperAdmin(request);
    const params = request.params as { id?: unknown };
    assertUuidParam(params.id);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const attestation_type = requireString(body, 'attestation_type');
    const status = requireString(body, 'status');
    if (!VALID_ATTESTATION_STATUSES.has(status as CloudAttestationStatus)) {
      throw new AppError(400, `invalid status: ${status}`);
    }
    const attested_by = requireString(body, 'attested_by');
    const findings = optionalString(body, 'findings');

    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const { rows: acctRows } = await client.query<{ id: string }>(
        `SELECT id FROM cloud_infrastructure WHERE id = $1 FOR UPDATE`, [params.id],
      );
      if (acctRows.length === 0) {
        await client.query('ROLLBACK');
        throw new AppError(404, 'cloud account not found');
      }

      const { rows: recordRows } = await client.query<{ id: string; created_at: string; content_hash: string }>(
        `INSERT INTO cloud_security_attestations
           (account_id, attestation_type, status, attested_by, findings)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, created_at, content_hash`,
        [params.id, attestation_type, status, attested_by, findings],
      );
      const record = recordRows[0]!;

      // AC 14: only status='pass' emits a signal; fail/partial are stored evidence
      // without an evaluator signal.
      if (status === 'pass') {
        await emitGrcSignal(client, {
          productSlug: PORTFOLIO_PRODUCT_SLUG,
          controlKey: CONTROL_KEY_CLOUD_SECURITY,
          signalType: SIGNAL_CLOUD_SECURITY_ATTESTED,
          entityId: record.id,
          payload: { account_id: params.id, attestation_type, attested_by },
          observedAt: new Date(record.created_at),
        });
      }

      await client.query('COMMIT');
      return reply.status(201).send({
        id: record.id,
        account_id: params.id,
        attestation_type,
        status,
        attested_by,
        findings,
        content_hash: record.content_hash,
        created_at: record.created_at,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  //  Policy register (AC 10-13)
  // ─────────────────────────────────────────────────────────────────────────

  fastify.post('/api/v1/admin/grc/policies', async (request, reply) => {
    assertSuperAdmin(request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const policy_name = requireString(body, 'policy_name');
    const policy_type = requireString(body, 'policy_type');
    if (!VALID_POLICY_TYPES.has(policy_type as PolicyType)) {
      throw new AppError(400, `invalid policy_type: ${policy_type}`);
    }
    const version = requireString(body, 'version');
    const effective_date = optionalString(body, 'effective_date');
    const review_due_date = optionalString(body, 'review_due_date');
    const review_frequency_days = optionalInt(body, 'review_frequency_days') ?? 365;
    const owner_id = optionalString(body, 'owner_id');
    const document_url = optionalString(body, 'document_url');

    const { rows } = await getPool().query(
      `INSERT INTO policy_register
         (policy_name, policy_type, version, effective_date, review_due_date,
          review_frequency_days, owner_id, document_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [policy_name, policy_type, version, effective_date, review_due_date,
        review_frequency_days, owner_id, document_url],
    );
    return reply.status(201).send(rows[0]);
  });

  fastify.get('/api/v1/admin/grc/policies', async (request) => {
    assertOperator(request);
    const q = (request.query ?? {}) as Record<string, unknown>;
    const { page, pageSize, limit, offset } = parsePagination(q);
    const typeFilter = typeof q.policy_type === 'string' ? q.policy_type : null;
    const statusFilter =
      typeof q.status === 'string' && VALID_REGISTER_STATUSES.has(q.status) ? q.status : null;

    const conditions: string[] = [];
    const params: unknown[] = [];
    if (typeFilter) { params.push(typeFilter); conditions.push(`policy_type = $${params.length}`); }
    if (statusFilter) { params.push(statusFilter); conditions.push(`status = $${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows: totalRows } = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM policy_register ${where}`, params,
    );
    const total = parseInt(totalRows[0]!.count, 10);

    params.push(limit, offset);
    const { rows: data } = await getPool().query(
      `SELECT * FROM policy_register ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { data, total, page, pageSize };
  });

  fastify.put('/api/v1/admin/grc/policies/:id', async (request) => {
    assertSuperAdmin(request);
    const params = request.params as { id?: unknown };
    assertUuidParam(params.id);
    const body = (request.body ?? {}) as Record<string, unknown>;

    const fields = [
      'policy_name', 'policy_type', 'version', 'effective_date', 'review_due_date',
      'review_frequency_days', 'owner_id', 'document_url',
    ];
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const f of fields) {
      if (Object.prototype.hasOwnProperty.call(body, f)) {
        values.push(body[f]);
        sets.push(`${f} = $${values.length}`);
      }
    }
    if (sets.length === 0) throw new AppError(400, 'no updatable fields provided');
    sets.push('updated_at = NOW()');
    values.push(params.id);
    const { rows } = await getPool().query(
      `UPDATE policy_register SET ${sets.join(', ')}
        WHERE id = $${values.length}
        RETURNING *`,
      values,
    );
    if (rows.length === 0) throw new AppError(404, 'policy not found');
    return rows[0];
  });

  // AC 6: policy acknowledgment on behalf of an employee. Wave 4b is
  // portfolio-scoped, so operatorRbacHook (tenant-scoped) blocks product_admin
  // upstream of this handler — meaning the operational role for Wave 4b is
  // super_admin. Employee self-service is out of scope for this wave.
  fastify.post('/api/v1/admin/grc/policies/:id/acknowledge', async (request, reply) => {
    assertSuperAdmin(request);
    const params = request.params as { id?: unknown };
    assertUuidParam(params.id);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const employee_id = requireString(body, 'employee_id');
    const employee_name = requireString(body, 'employee_name');
    const policy_version = requireString(body, 'policy_version');
    const acknowledgedAt = new Date();

    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const { rows: policyRows } = await client.query<{ id: string }>(
        `SELECT id FROM policy_register WHERE id = $1 FOR UPDATE`, [params.id],
      );
      if (policyRows.length === 0) {
        await client.query('ROLLBACK');
        throw new AppError(404, 'policy not found');
      }

      const { rows: recordRows } = await client.query<{ id: string; created_at: string; content_hash: string }>(
        `INSERT INTO policy_acknowledgments
           (policy_id, employee_id, employee_name, acknowledged_at, policy_version)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, created_at, content_hash`,
        [params.id, employee_id, employee_name, acknowledgedAt.toISOString(), policy_version],
      );
      const record = recordRows[0]!;

      await emitGrcSignal(client, {
        productSlug: PORTFOLIO_PRODUCT_SLUG,
        controlKey: CONTROL_KEY_POLICY_ACK,
        signalType: SIGNAL_POLICY_ACKNOWLEDGED,
        entityId: record.id,
        payload: { policy_id: params.id, employee_id, policy_version },
        observedAt: acknowledgedAt,
      });

      await client.query('COMMIT');
      return reply.status(201).send({
        id: record.id,
        policy_id: params.id,
        employee_id,
        employee_name,
        policy_version,
        acknowledged_at: acknowledgedAt.toISOString(),
        content_hash: record.content_hash,
        created_at: record.created_at,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  });
};

export default adminGrcVendorCloudPolicyRoutes;
