// Authorized by HUB-1377 — queryEvidence(): evidence query service with filter types and pagination
// Authorized by HUB-1380 — generateExportBundle(): ZIP assembly, signed manifest, content hash verification
// Authorized by HUB-1381 — buildCoverDocument(): auditor-facing markdown summary generator
// Authorized by HUB-1382 — createExportJob(), getExportJob(): async job lifecycle management
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zipSync, strToU8 } from 'fflate';
import { getPool } from '../db/pool.js';
import logger from '../lib/logger.js';

export interface ExportFilters {
  productId?: string;
  tscCategory?: string;
  controlClass?: string;
  dateFrom: Date;
  dateTo: Date;
}

export interface EvidenceRecord {
  id: string;
  product_id: string;
  control_id: string;
  signal_id: string;
  content_hash: string;
  payload: unknown;
  signal_type: string;
  observed_at: Date;
  received_at: Date;
  is_burn_in_gap: boolean;
  control_key: string;
  control_name: string;
  tsc_category: string;
  control_class: string;
}

export interface ExportJob {
  id: string;
  requested_by: string;
  product_id: string | null;
  tsc_category: string | null;
  control_class: string | null;
  date_from: Date;
  date_to: Date;
  status: 'pending' | 'running' | 'completed' | 'failed';
  bundle_path: string | null;
  bundle_hash: string | null;
  record_count: number | null;
  error_message: string | null;
  created_at: Date;
  completed_at: Date | null;
}

// ── Evidence query ────────────────────────────────────────────────────────────

export async function queryEvidence(
  filters: ExportFilters,
  limit = 5000,
  offset = 0,
): Promise<{ records: EvidenceRecord[]; total: number }> {
  const pool = getPool();

  const conditions: string[] = [
    'se.is_burn_in_gap = false',
    'se.observed_at >= $1',
    'se.observed_at <= $2',
  ];
  const params: unknown[] = [filters.dateFrom, filters.dateTo];

  if (filters.productId) {
    params.push(filters.productId);
    conditions.push(`se.product_id = $${params.length}`);
  }
  if (filters.tscCategory) {
    params.push(filters.tscCategory);
    conditions.push(`c.tsc_category = $${params.length}`);
  }
  if (filters.controlClass) {
    params.push(filters.controlClass);
    conditions.push(`c.control_class = $${params.length}`);
  }

  const where = conditions.join(' AND ');

  params.push(limit);
  params.push(offset);

  const { rows } = await pool.query<EvidenceRecord & { total_count: string }>(
    `SELECT se.id, se.product_id, se.control_id, se.signal_id, se.content_hash,
            se.payload, se.signal_type, se.observed_at, se.received_at, se.is_burn_in_gap,
            c.control_id AS control_key, c.name AS control_name,
            c.tsc_category, c.control_class,
            COUNT(*) OVER() AS total_count
     FROM compliance_signal_evidence se
     JOIN compliance_controls c ON c.id = se.control_id
     WHERE ${where}
     ORDER BY se.observed_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  const total = rows.length > 0 ? parseInt((rows[0] as unknown as { total_count: string }).total_count, 10) : 0;
  const records = rows.map(({ total_count: _tc, ...rest }) => rest as EvidenceRecord);
  return { records, total };
}

// ── Control registry snapshot ─────────────────────────────────────────────────

async function getControlsSnapshot(filters: ExportFilters): Promise<unknown[]> {
  const pool = getPool();
  const params: unknown[] = [];
  const conditions: string[] = ['c.active = true'];

  if (filters.tscCategory) {
    params.push(filters.tscCategory);
    conditions.push(`c.tsc_category = $${params.length}`);
  }
  if (filters.controlClass) {
    params.push(filters.controlClass);
    conditions.push(`c.control_class = $${params.length}`);
  }

  const { rows } = await pool.query(
    `SELECT control_id, name, description, tsc_category, control_class, eval_cadence, created_at
     FROM compliance_controls c
     WHERE ${conditions.join(' AND ')}
     ORDER BY tsc_category ASC, control_id ASC`,
    params,
  );
  return rows;
}

// ── Verdict log for period ────────────────────────────────────────────────────

async function getVerdictLogForPeriod(filters: ExportFilters): Promise<unknown[]> {
  const pool = getPool();
  const params: unknown[] = [filters.dateFrom, filters.dateTo];
  const conditions: string[] = ['vh.evaluated_at >= $1', 'vh.evaluated_at <= $2'];

  if (filters.productId) {
    params.push(filters.productId);
    conditions.push(`vh.product_id = $${params.length}`);
  }

  const { rows } = await pool.query(
    `SELECT vh.product_id, c.control_id AS control_key, c.name AS control_name,
            c.tsc_category, vh.verdict, vh.evaluated_at, vh.signal_id
     FROM compliance_verdict_history vh
     JOIN compliance_controls c ON c.id = vh.control_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY vh.evaluated_at DESC, c.tsc_category ASC, c.control_id ASC`,
    params,
  );
  return rows;
}

// ── Cover document ────────────────────────────────────────────────────────────

export function buildCoverDocument(
  jobId: string,
  filters: ExportFilters,
  records: EvidenceRecord[],
  verdictRows: unknown[],
): string {
  const verdicts = verdictRows as Array<{
    tsc_category: string;
    verdict: string;
    control_key: string;
    product_id: string;
    evaluated_at?: string;
  }>;

  // Per-category pass rates
  const categoryMap = new Map<string, { pass: number; total: number }>();
  for (const v of verdicts) {
    const entry = categoryMap.get(v.tsc_category) ?? { pass: 0, total: 0 };
    entry.total++;
    if (v.verdict === 'pass') entry.pass++;
    categoryMap.set(v.tsc_category, entry);
  }

  const categoryRows = Array.from(categoryMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cat, { pass, total }]) => {
      const pct = total > 0 ? ((pass / total) * 100).toFixed(1) : '0.0';
      return `| ${cat} | ${pass} | ${total} | ${pct}% |`;
    })
    .join('\n');

  // FAIL periods
  const failRows = verdicts
    .filter((v) => v.verdict === 'fail' || v.verdict === 'overdue')
    .slice(0, 50)
    .map((v) => `| ${v.evaluated_at ?? ''} | ${v.control_key} | ${v.tsc_category} | ${v.verdict} |`)
    .join('\n');

  const lines: string[] = [
    `# HUB Compliance Evidence Package`,
    ``,
    `**Job ID:** ${jobId}`,
    `**Generated:** ${new Date().toISOString()}`,
    `**Period:** ${filters.dateFrom.toISOString().slice(0, 10)} to ${filters.dateTo.toISOString().slice(0, 10)}`,
    `**Product filter:** ${filters.productId ?? 'All products'}`,
    `**TSC category filter:** ${filters.tscCategory ?? 'All categories'}`,
    `**Control class filter:** ${filters.controlClass ?? 'All classes'}`,
    `**Total evidence records:** ${records.length}`,
    ``,
    `---`,
    ``,
    `## Pass Rates by TSC Category`,
    ``,
    `| Category | Pass | Total Verdicts | Pass Rate |`,
    `|----------|------|----------------|-----------|`,
    categoryRows || `| (no verdicts in period) | — | — | — |`,
    ``,
    `---`,
    ``,
    `## FAIL / Overdue Events`,
    ``,
    failRows
      ? [`| Evaluated At | Control | Category | Verdict |`, `|---|---|---|---|`, failRows].join('\n')
      : `No FAIL or overdue events in this period.`,
    ``,
    `---`,
    ``,
    `## Bundle Integrity`,
    ``,
    `Each evidence record in the \`evidence/\` directory is identified by its \`signal_id\`.`,
    `The \`manifest.json\` file lists the SHA-256 content hash for every evidence record.`,
    `The \`manifest.signature\` file contains the SHA-256 hash of \`manifest.json\`.`,
    ``,
    `To verify record integrity without HUB access:`,
    `1. Compute SHA-256 of each file in \`evidence/\``,
    `2. Compare against the matching entry in \`manifest.json\``,
    `3. Compute SHA-256 of \`manifest.json\` and compare against \`manifest.signature\``,
  ];

  return lines.join('\n');
}

// ── Bundle generation ─────────────────────────────────────────────────────────

export async function generateExportBundle(jobId: string, filters: ExportFilters): Promise<void> {
  const pool = getPool();

  await pool.query(
    `UPDATE compliance_export_jobs SET status = 'running' WHERE id = $1`,
    [jobId],
  );

  try {
    const { records } = await queryEvidence(filters, 10_000, 0);
    const controls = await getControlsSnapshot(filters);
    const verdicts = await getVerdictLogForPeriod(filters);

    const coverDoc = buildCoverDocument(jobId, filters, records, verdicts);

    // Build manifest: {signal_id -> content_hash}
    const manifestEntries: Record<string, string> = {};
    for (const r of records) {
      manifestEntries[r.signal_id] = r.content_hash;
    }
    const manifestJson = JSON.stringify(
      {
        bundle_id: jobId,
        generated_at: new Date().toISOString(),
        filters: {
          product_id: filters.productId ?? null,
          tsc_category: filters.tscCategory ?? null,
          control_class: filters.controlClass ?? null,
          date_from: filters.dateFrom.toISOString(),
          date_to: filters.dateTo.toISOString(),
        },
        record_count: records.length,
        records: manifestEntries,
      },
      null,
      2,
    );

    const manifestHash = createHash('sha256').update(manifestJson).digest('hex');

    // Assemble ZIP entries
    const zipEntries: Record<string, Uint8Array> = {
      'cover.md': strToU8(coverDoc),
      'manifest.json': strToU8(manifestJson),
      'manifest.signature': strToU8(manifestHash),
      'controls/registry-snapshot.json': strToU8(JSON.stringify(controls, null, 2)),
      'verdicts/verdict-log.json': strToU8(JSON.stringify(verdicts, null, 2)),
    };

    for (const record of records) {
      const filename = `evidence/${record.signal_id}.json`;
      zipEntries[filename] = strToU8(JSON.stringify(record, null, 2));
    }

    const zipped = zipSync(zipEntries);
    const bundlePath = join(tmpdir(), `hub-export-${jobId}.zip`);
    writeFileSync(bundlePath, Buffer.from(zipped));

    const bundleHash = createHash('sha256').update(Buffer.from(zipped)).digest('hex');

    await pool.query(
      `UPDATE compliance_export_jobs
       SET status = 'completed', bundle_path = $2, bundle_hash = $3,
           record_count = $4, completed_at = NOW()
       WHERE id = $1`,
      [jobId, bundlePath, bundleHash, records.length],
    );

    logger.info({ jobId, recordCount: records.length, bundleHash }, 'Export bundle generated');
  } catch (err) {
    await pool.query(
      `UPDATE compliance_export_jobs
       SET status = 'failed', error_message = $2, completed_at = NOW()
       WHERE id = $1`,
      [jobId, (err as Error).message],
    );
    logger.error({ err, jobId }, 'Export bundle generation failed');
    throw err;
  }
}

// ── Job lifecycle ─────────────────────────────────────────────────────────────

export async function createExportJob(filters: ExportFilters, requestedBy: string): Promise<string> {
  const pool = getPool();

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO compliance_export_jobs
       (requested_by, product_id, tsc_category, control_class, date_from, date_to)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      requestedBy,
      filters.productId ?? null,
      filters.tscCategory ?? null,
      filters.controlClass ?? null,
      filters.dateFrom,
      filters.dateTo,
    ],
  );
  const jobId = rows[0]!.id;

  // Non-blocking: fire bundle generation asynchronously
  generateExportBundle(jobId, filters).catch((err) =>
    logger.error({ err, jobId }, 'Async export bundle generation failed'),
  );

  return jobId;
}

export async function getExportJob(jobId: string): Promise<ExportJob | null> {
  const pool = getPool();
  const { rows } = await pool.query<ExportJob>(
    `SELECT id, requested_by, product_id, tsc_category, control_class,
            date_from, date_to, status, bundle_path, bundle_hash,
            record_count, error_message, created_at, completed_at
     FROM compliance_export_jobs
     WHERE id = $1`,
    [jobId],
  );
  return rows[0] ?? null;
}
