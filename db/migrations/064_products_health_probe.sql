-- Authorized by HUB-1545 (System Health spec-deviation close-out) —
-- introduce a per-product liveness probe so /admin/system-health/portfolio
-- can surface real reachability instead of using `products.active` as a
-- proxy. Design keeps the write path minimal:
--
--   products.health_check_url        — nullable; when NULL, probe is
--                                      skipped and `active` remains the
--                                      reachability proxy (backward-
--                                      compatible with pre-064 behaviour).
--   products.last_probe_at           — TIMESTAMPTZ; NULL until the first
--                                      probe runs against a configured URL.
--   products.last_probe_reachable    — nullable BOOLEAN; NULL when no
--                                      probe has run yet.
--
-- Probes execute on-demand inside computePortfolio() with a 60s freshness
-- TTL — no separate scheduled job needed at v0.1. If we later add a
-- scheduled probe worker, it can populate the same columns.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS health_check_url        TEXT,
  ADD COLUMN IF NOT EXISTS last_probe_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_probe_reachable    BOOLEAN,
  ADD COLUMN IF NOT EXISTS last_probe_error        TEXT,
  ADD COLUMN IF NOT EXISTS last_probe_latency_ms   INTEGER;
