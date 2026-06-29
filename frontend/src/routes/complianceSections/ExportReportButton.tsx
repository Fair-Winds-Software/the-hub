// Authorized by HUB-1627 (E-FE-8 S8) — "Export Report" button for the HUB-1623
// compliance drill-in. Tries the BE export endpoint first; on 404 it composes
// the export envelope client-side from the drill-in detail already loaded
// (per HUB-1559 §6 fallback). Triggers a JSON download via Blob + anchor.
//
// The export action is itself audit-logged via the existing E25
// auditLogReadAccess middleware (the BE endpoint hit covers it); no new audit
// surface needed at the FE.
import { useCallback, useState } from 'react';
import { apiClient } from '../../lib/api';
import { useOperator } from '../../stores/sessionStore';
import type { ComplianceDetail } from '../ComplianceDetail';
import {
  composeComplianceExport,
  formatExportFilename,
  triggerJsonDownload,
  type ComplianceExportEnvelope,
} from './composeComplianceExport';

const EXPORT_PATH = (productId: string): string =>
  `/api/v1/admin/compliance/${productId}/export`;

export interface ExportReportButtonProps {
  detail: ComplianceDetail;
}

function is404(err: unknown): boolean {
  return (
    err instanceof Error && /\b404\b|not found/i.test(err.message)
  );
}

export function ExportReportButton({
  detail,
}: ExportReportButtonProps): React.ReactElement {
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operator = useOperator();

  const handleClick = useCallback(async () => {
    setExporting(true);
    setError(null);
    try {
      let envelope: ComplianceExportEnvelope;
      try {
        envelope = await apiClient.get<ComplianceExportEnvelope>(
          EXPORT_PATH(detail.productId),
        );
      } catch (err) {
        if (is404(err)) {
          // Spec'd fallback: compose from already-loaded detail.
          envelope = composeComplianceExport(detail, {
            exportedBy: operator?.email ?? null,
          });
        } else {
          throw err;
        }
      }
      const filename = formatExportFilename(detail.productId);
      triggerJsonDownload({ filename, envelope });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unable to export. Try again?';
      setError(message);
    } finally {
      setExporting(false);
    }
  }, [detail, operator]);

  return (
    <div
      className="flex flex-col items-end gap-1"
      data-testid="export-report-wrapper"
    >
      <button
        type="button"
        onClick={() => void handleClick()}
        disabled={exporting}
        aria-label="Export compliance report as JSON"
        aria-busy={exporting}
        data-testid="export-report-button"
        className="inline-flex items-center gap-1 rounded-md border border-primary-navy/20 bg-white px-3 py-1.5 text-sm font-body text-primary-navy shadow-sm hover:bg-primary-navy/5 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent-brass"
      >
        {exporting ? 'Exporting…' : 'Export Report'}
      </button>
      {error !== null && (
        <div
          role="alert"
          data-testid="export-report-error"
          className="flex flex-col items-end gap-1 rounded-md border border-ironwake/40 bg-ironwake/5 p-2 text-xs font-body text-ironwake"
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={() => void handleClick()}
            className="underline focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
