// Authorized by HUB-1627 (E-FE-8 S8) — client-side fallback composer for the
// compliance export. When the BE export endpoint is missing (404), we assemble
// the export envelope from the drill-in detail response already loaded in
// memory + a session-supplied actor. The envelope shape is the spec contract
// (AC-E4): every key on the list below MUST be present, even if the underlying
// data is empty.
import type { ComplianceDetail } from '../ComplianceDetail';

export interface ComplianceExportEnvelope {
  productId: string;
  productName: string;
  currentPosture: number;
  verdict: 'healthy' | 'warning' | 'error';
  lastEvaluated: string | null;
  controls: unknown[];
  history: unknown[];
  driftSignals: unknown[];
  exportedAt: string;
  exportedBy: string;
}

function scoreToVerdict(score: number): ComplianceExportEnvelope['verdict'] {
  if (score >= 85) return 'healthy';
  if (score >= 60) return 'warning';
  return 'error';
}

export interface ComposeOptions {
  /** Now-clock injection point so tests can pin exportedAt deterministically. */
  now?: Date;
  /** Authenticated operator email; falls back to '(unknown)' when absent. */
  exportedBy?: string | null;
}

export function composeComplianceExport(
  detail: ComplianceDetail,
  options: ComposeOptions = {},
): ComplianceExportEnvelope {
  const now = options.now ?? new Date();
  return {
    productId: detail.productId,
    productName: detail.productName,
    currentPosture: detail.score,
    verdict: scoreToVerdict(detail.score),
    lastEvaluated: detail.last_evaluated_at,
    controls: detail.controls ?? [],
    history: detail.history ?? [],
    driftSignals: detail.drift_signals ?? [],
    exportedAt: now.toISOString(),
    exportedBy: options.exportedBy ?? '(unknown)',
  };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatExportFilename(
  productId: string,
  now: Date = new Date(),
): string {
  const y = now.getFullYear();
  const mo = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const h = pad(now.getHours());
  const mi = pad(now.getMinutes());
  const s = pad(now.getSeconds());
  return `hub-compliance-${productId}-${y}${mo}${d}-${h}${mi}${s}.json`;
}

export interface TriggerDownloadOptions {
  filename: string;
  envelope: ComplianceExportEnvelope;
}

export function triggerJsonDownload({
  filename,
  envelope,
}: TriggerDownloadOptions): void {
  const text = JSON.stringify(envelope, null, 2);
  // UTF-8 BOM so editors that auto-detect encoding pick the right one.
  const blob = new Blob(['﻿', text], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
