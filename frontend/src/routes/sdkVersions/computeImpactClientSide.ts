// Authorized by HUB-1634 (E-FE-10 S5) — pure client-side fallback for the
// deprecation-impact computation. Used when the BE impact endpoint returns
// 404 (per HUB-1560 §6 fallback contract). Filters the already-loaded
// product breakdown rows down to those running the deprecated version OR
// older — those products would break on deprecation.
//
// Comparison is on a relaxed semver shape (major.minor.patch); fall back to
// lexicographic when the shape doesn't parse so we don't crash on exotic
// version identifiers (release candidates, build metadata).
import type { ProductBreakdownRow } from './ProductBreakdownTable';

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)/;

function semverParts(version: string): [number, number, number] | null {
  const match = SEMVER_RE.exec(version);
  if (!match) return null;
  return [
    parseInt(match[1]!, 10),
    parseInt(match[2]!, 10),
    parseInt(match[3]!, 10),
  ];
}

/**
 * Returns true when `candidate` is the deprecated version OR older. The
 * comparison prefers semver-aware ordering but degrades to lexicographic
 * when either input is unparseable.
 */
export function isAtOrOlderThan(
  candidate: string,
  deprecated: string,
): boolean {
  const a = semverParts(candidate);
  const b = semverParts(deprecated);
  if (!a || !b) return candidate <= deprecated;
  for (let i = 0; i < 3; i++) {
    if (a[i]! < b[i]!) return true;
    if (a[i]! > b[i]!) return false;
  }
  return true; // equal counts as "would break"
}

export interface ClientSideImpactResult {
  impactedCount: number;
  products: Array<{
    productId: string;
    productName: string;
    currentVersion: string;
  }>;
}

export function computeImpactClientSide(
  products: ProductBreakdownRow[],
  deprecatedVersion: string,
): ClientSideImpactResult {
  const impacted = products
    .filter((p) => isAtOrOlderThan(p.currentVersion, deprecatedVersion))
    .map((p) => ({
      productId: p.productId,
      productName: p.productName,
      currentVersion: p.currentVersion,
    }));
  return {
    impactedCount: impacted.length,
    products: impacted,
  };
}
