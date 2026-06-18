// Authorized by HUB-1377 — GET /api/v1/admin/compliance/exports/query: paginated evidence query with filters
// Authorized by HUB-1380 — POST /api/v1/admin/compliance/exports: create export job; bundle gen with signed manifest
// Authorized by HUB-1381 — cover document included in bundle generation service
// Authorized by HUB-1382 — GET /api/v1/admin/compliance/exports/:id: job status; GET .../download: stream ZIP
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import {
  queryEvidence,
  createExportJob,
  getExportJob,
  type ExportFilters,
} from '../../services/evidenceExportService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const adminComplianceExportRoutes: FastifyPluginAsync = async (fastify) => {

  // ── Evidence query (paginated, filter-only — no bundle) ──────────────────────

  fastify.get('/api/v1/admin/compliance/exports/query', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;

    const dateFrom = q.date_from ? new Date(q.date_from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000);
    const dateTo = q.date_to ? new Date(q.date_to) : new Date();

    if (isNaN(dateFrom.getTime()) || isNaN(dateTo.getTime())) {
      throw new AppError(400, 'date_from and date_to must be valid ISO-8601 timestamps');
    }
    if (dateFrom >= dateTo) throw new AppError(400, 'date_from must be before date_to');

    const limit = Math.min(parseInt(q.limit ?? '100', 10), 500);
    const offset = parseInt(q.offset ?? '0', 10);

    const filters: ExportFilters = {
      productId: q.product_id,
      tscCategory: q.tsc_category,
      controlClass: q.control_class,
      dateFrom,
      dateTo,
    };

    const { records, total } = await queryEvidence(filters, limit, offset);
    return reply.send({ records, total, limit, offset });
  });

  // ── Create export job ─────────────────────────────────────────────────────────

  fastify.post('/api/v1/admin/compliance/exports', async (request, reply) => {
    const b = request.body as Record<string, unknown>;
    const op = request.operatorUser!;

    const dateFrom = b.date_from ? new Date(b.date_from as string) : null;
    const dateTo = b.date_to ? new Date(b.date_to as string) : null;

    if (!dateFrom || isNaN(dateFrom.getTime())) {
      throw new AppError(400, 'date_from is required and must be a valid ISO-8601 timestamp');
    }
    if (!dateTo || isNaN(dateTo.getTime())) {
      throw new AppError(400, 'date_to is required and must be a valid ISO-8601 timestamp');
    }
    if (dateFrom >= dateTo) throw new AppError(400, 'date_from must be before date_to');

    const productId = typeof b.product_id === 'string' ? b.product_id : undefined;
    if (productId && !UUID_RE.test(productId)) {
      throw new AppError(400, 'product_id must be a valid UUID');
    }

    const tscCategory = typeof b.tsc_category === 'string' ? b.tsc_category : undefined;
    const controlClass = typeof b.control_class === 'string' ? b.control_class : undefined;
    if (controlClass && !['automated', 'human'].includes(controlClass)) {
      throw new AppError(400, "control_class must be 'automated' or 'human'");
    }

    const filters: ExportFilters = { productId, tscCategory, controlClass, dateFrom, dateTo };
    const requestedBy = op.operator_id ?? 'unknown';

    const jobId = await createExportJob(filters, requestedBy);
    return reply.status(202).send({ job_id: jobId, status: 'pending' });
  });

  // ── Job status ────────────────────────────────────────────────────────────────

  fastify.get('/api/v1/admin/compliance/exports/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!UUID_RE.test(id)) throw new AppError(400, 'id must be a valid UUID');

    const job = await getExportJob(id);
    if (!job) throw new AppError(404, 'Export job not found');

    const { bundle_path: _bp, ...safe } = job as typeof job & { bundle_path: unknown };
    return reply.send(safe);
  });

  // ── Download bundle ───────────────────────────────────────────────────────────

  fastify.get('/api/v1/admin/compliance/exports/:id/download', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!UUID_RE.test(id)) throw new AppError(400, 'id must be a valid UUID');

    const job = await getExportJob(id);
    if (!job) throw new AppError(404, 'Export job not found');
    if (job.status === 'pending' || job.status === 'running') {
      throw new AppError(409, `Export job is still ${job.status} — try again when status is completed`);
    }
    if (job.status === 'failed') {
      throw new AppError(422, `Export job failed: ${job.error_message ?? 'unknown error'}`);
    }
    if (!job.bundle_path) {
      throw new AppError(500, 'Export job completed but bundle path is missing');
    }

    // Verify file still exists
    try {
      await stat(job.bundle_path);
    } catch {
      throw new AppError(410, 'Export bundle file is no longer available — re-run the export');
    }

    const filename = `hub-export-${id}.zip`;
    void reply.header('Content-Type', 'application/zip');
    void reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    if (job.bundle_hash) {
      void reply.header('X-Bundle-Hash', job.bundle_hash);
    }

    return reply.send(createReadStream(job.bundle_path));
  });
};

export default adminComplianceExportRoutes;
