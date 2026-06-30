// Authorized by HUB-1635 (E-FE-10 S6) — client-side CSV export of the SDK
// product breakdown. Mirrors the HUB-1617 audit-log CSV pattern: RFC 4180
// (comma delimiter, CRLF line terminator, fields wrapped in double quotes
// when they contain a quote / comma / newline, embedded quotes doubled),
// Blob + anchor download, UTF-8 BOM so editors that auto-detect encoding
// pick UTF-8.
import type { ProductBreakdownRow } from './ProductBreakdownTable';

const CRLF = '\r\n';

const CSV_HEADERS = [
  'Product',
  'Current SDK Version',
  'Last Reported',
  'Days Behind Latest',
  'Status',
] as const;

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function buildSdkVersionsCsv(rows: ProductBreakdownRow[]): string {
  const headerLine = CSV_HEADERS.map(csvEscape).join(',');
  const dataLines = rows.map((r) =>
    [
      r.productName,
      r.currentVersion,
      r.lastReportedAt,
      String(r.daysBehindLatest),
      r.status,
    ]
      .map(csvEscape)
      .join(','),
  );
  return [headerLine, ...dataLines].join(CRLF) + CRLF;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatExportFilename(
  sdkName: string,
  now: Date = new Date(),
): string {
  const y = now.getFullYear();
  const mo = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const h = pad(now.getHours());
  const mi = pad(now.getMinutes());
  const s = pad(now.getSeconds());
  return `hub-sdk-versions-${sdkName}-${y}${mo}${d}-${h}${mi}${s}.csv`;
}

export interface ExportSdkVersionsCsvOptions {
  /** Now-clock injection point for deterministic filenames in tests. */
  now?: Date;
}

/**
 * Build the CSV in memory, wrap in a Blob, trigger a programmatic anchor
 * click. Returns the filename used. Throws on empty input — callers
 * disable the trigger upstream; defense in depth here matches the AC#6
 * contract.
 */
export function exportSdkVersionsCsv(
  rows: ProductBreakdownRow[],
  sdkName: string,
  options: ExportSdkVersionsCsvOptions = {},
): string {
  if (rows.length === 0) {
    throw new Error(
      'exportSdkVersionsCsv: refusing to export an empty breakdown.',
    );
  }
  const filename = formatExportFilename(sdkName, options.now ?? new Date());
  const csv = buildSdkVersionsCsv(rows);
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
  return filename;
}
