// Authorized by HUB-1617 (E-FE-12 S7) — client-side CSV export of the current audit
// result page. RFC 4180-compliant: comma delimiter, CRLF line terminator, fields
// containing comma / quote / newline are wrapped in double quotes and embedded
// double quotes are doubled per the spec. No new BE endpoint at v0.1 — bounded to
// the page the operator already has loaded (max 50 rows per HUB-1558 §9 Risk-3).
//
// The "Detail" column contains the FULL JSON of notes / before / after — unlike the
// 80-char preview in the on-screen table — so the export carries the audit evidence
// auditors actually need.
import type { AuditRow } from './AuditFilters';

const CRLF = '\r\n';

const CSV_HEADERS = [
  'Timestamp',
  'Actor',
  'Action',
  'Entity Type',
  'Entity ID',
  'Detail',
] as const;

function csvEscape(value: string): string {
  // RFC 4180: wrap in quotes only when the value contains the delimiter, a quote,
  // or a newline. Escape embedded quotes by doubling them.
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function detailJson(row: AuditRow): string {
  const payload: Record<string, unknown> = {};
  if (row.notes) payload.notes = row.notes;
  if (row.before_value !== null && row.before_value !== undefined)
    payload.before = row.before_value;
  if (row.after_value !== null && row.after_value !== undefined)
    payload.after = row.after_value;
  return JSON.stringify(payload);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatExportFilename(now: Date): string {
  const y = now.getFullYear();
  const mo = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const h = pad(now.getHours());
  const mi = pad(now.getMinutes());
  const s = pad(now.getSeconds());
  return `hub-audit-export-${y}${mo}${d}-${h}${mi}${s}.csv`;
}

export function buildAuditCsv(rows: AuditRow[]): string {
  const headerLine = CSV_HEADERS.map(csvEscape).join(',');
  const lines = rows.map((r) =>
    [
      r.created_at,
      r.operator_id ?? '',
      r.action,
      r.entity_type,
      r.entity_id,
      detailJson(r),
    ]
      .map(csvEscape)
      .join(','),
  );
  return [headerLine, ...lines].join(CRLF) + CRLF;
}

export interface ExportAuditCsvOptions {
  /** Now-clock injection point for deterministic filename in tests. */
  now?: Date;
}

/**
 * Build the CSV in memory, wrap it in a Blob, and programmatically click an anchor
 * to trigger the browser download. Returns the filename used so callers can show
 * confirmation UI; throws if `rows` is empty (callers should disable the trigger
 * upstream — defense in depth here matches the AC#6 contract).
 */
export function exportAuditCsv(
  rows: AuditRow[],
  options: ExportAuditCsvOptions = {},
): string {
  if (rows.length === 0) {
    throw new Error('exportAuditCsv: refusing to export an empty result set.');
  }
  const filename = formatExportFilename(options.now ?? new Date());
  const csv = buildAuditCsv(rows);
  // BOM keeps Excel happy with UTF-8; standards-only readers strip it cleanly.
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  // Append → click → remove → revoke. The append is required by some browsers
  // (Firefox historically) for the programmatic click to fire.
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
  return filename;
}
