// Authorized by HUB-1385 (E-CMP-WAVE4 S2, HUB-870) — pagination query-string helper for
// GET list endpoints. Clamps pageSize to a fixed max so pathological requests can't
// stream unbounded result sets; defaults match the story AC (page=1, pageSize=50).

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export interface PaginationParams {
  page: number;
  pageSize: number;
  limit: number;
  offset: number;
}

/**
 * Parses `page` + `pageSize` from a query object. Coerces strings via parseInt;
 * silently substitutes defaults for missing / non-numeric / non-positive values.
 * pageSize is clamped to [1, MAX_PAGE_SIZE].
 */
export function parsePagination(query: unknown): PaginationParams {
  const q = (query ?? {}) as Record<string, unknown>;
  const rawPage = parseInt(String(q.page ?? ''), 10);
  const rawSize = parseInt(String(q.pageSize ?? ''), 10);

  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const requestedSize = Number.isFinite(rawSize) && rawSize > 0 ? rawSize : DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(requestedSize, MAX_PAGE_SIZE);

  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}
