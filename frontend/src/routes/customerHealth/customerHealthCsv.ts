// Authorized by HUB-1682 (E-FE-9 S3) — client-side CSV export utility.
// Generates a CSV from the currently-rendered rows so the export matches
// what the operator sees (a fresh BE fetch could return different data
// if the 5-min cache TTL expired between render and export click).
//
// No audit-log entry at v0.1 (underlying data was already audit-fetched
// via HUB-1680); revisit if SOC 2 requires explicit export tracking.

import {
  formatCurrency,
  formatDate,
  formatScore,
  badgeToRiskLevel,
} from './customer-health-formatters';
import type { HealthBadge, HealthListRow } from '../CustomerHealth';

const CSV_COLUMNS = [
  'Tenant',
  'Product',
  'Plan',
  'MRR',
  'Risk level',
  'Churn risk',
  'Last active',
  'Signals',
];

function escapeCsv(cell: string): string {
  // Quote fields that contain a comma, a double-quote, or a newline.
  if (/[",\n]/.test(cell)) return `"${cell.replace(/"/g, '""')}"`;
  return cell;
}

function rowToCsvCells(row: HealthListRow): string[] {
  return [
    row.tenantName,
    row.productName,
    row.planKey ?? '',
    formatCurrency(row.mrrCents),
    badgeToRiskLevel(row.healthBadge as HealthBadge),
    formatScore(row.churnRiskScore),
    row.lastActiveAt ? formatDate(row.lastActiveAt) : 'Never',
    row.signals.join('; '),
  ];
}

export function buildCsv(rows: HealthListRow[]): string {
  const lines: string[] = [];
  lines.push(CSV_COLUMNS.map(escapeCsv).join(','));
  for (const row of rows) {
    lines.push(rowToCsvCells(row).map(escapeCsv).join(','));
  }
  return lines.join('\n');
}

export function todayFilename(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `customer-health-${y}-${m}-${d}.csv`;
}

export function downloadCsv(rows: HealthListRow[], now: Date = new Date()): void {
  const csv = buildCsv(rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = todayFilename(now);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Revoke on the next tick so IE / older browsers still process the click.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
