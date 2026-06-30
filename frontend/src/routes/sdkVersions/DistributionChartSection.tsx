// Authorized by HUB-1632 (E-FE-10 S3) — Distribution chart section for the
// HUB-1631 SDK versions page. Renders a HUB-1630 <DistributionChart> with
// data sliced from the parent's distribution fetch (no separate API call at
// the section level — the parent SdkVersions page already issued the fetch
// against /api/v1/admin/sdk-versions/distribution?sdkName=<selected>).
//
// Parent passes both the loaded distribution + the current sdkName so this
// section can keep its empty-state copy ("No SDK reports for <name>") scoped
// to the filter without duplicating fetch state.
import { useMemo } from 'react';
import {
  DistributionChart,
  type DistributionPoint,
} from '../../components/DistributionChart';

export interface DistributionRow {
  version: string;
  productCount: number;
  products?: string[];
}

export interface DistributionChartSectionProps {
  sdkName: string;
  rows: DistributionRow[];
  loading?: boolean;
  error?: string | null;
}

export function DistributionChartSection({
  sdkName,
  rows,
  loading = false,
  error = null,
}: DistributionChartSectionProps): React.ReactElement {
  const data: DistributionPoint[] = useMemo(
    () =>
      rows.map((r) => ({
        category: r.version,
        count: r.productCount,
        items: r.products,
      })),
    [rows],
  );

  return (
    <section
      aria-labelledby="distribution-chart-section-heading"
      data-testid="sdk-versions-section-distribution"
      className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-4"
    >
      <h2
        id="distribution-chart-section-heading"
        className="font-heading text-lg text-primary-navy mb-2"
      >
        Distribution
      </h2>
      {!loading && error === null && rows.length === 0 ? (
        <div
          data-testid="distribution-section-empty"
          className="rounded-md border border-deep-charcoal/15 bg-white p-4 text-sm font-body text-deep-charcoal/70"
        >
          No SDK reports for <strong>{sdkName}</strong>.
        </div>
      ) : (
        <DistributionChart
          data={data}
          xLabel="SDK Version"
          yLabel="Product Count"
          totalUnit="products"
          loading={loading}
          error={error}
        />
      )}
    </section>
  );
}
