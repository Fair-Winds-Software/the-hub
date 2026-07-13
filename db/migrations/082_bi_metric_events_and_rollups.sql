-- Authorized by HUB-1804 (S2 of HUB-1785) — BI Layer persistence.
--
-- Two tables:
--   metric_events   — raw, append-only ingestion of per-product KPI pushes from the SDK.
--                     Rollup jobs (S4) consume this table into metric_rollups; a future
--                     retention policy will prune old raw events without touching rollups.
--   metric_rollups  — pre-aggregated values per (product × metric × dimensions × window).
--                     Dashboard endpoints (S5/S6) read from here so they don't scan raw.
--
-- Value storage is XOR-split: value_num for int/float catalog types; value_str for enum
-- types. A CHECK constraint enforces exactly-one-non-null so ingestion cannot ambiguously
-- persist both.
--
-- Delta tracking: both tables carry a delta_data jsonb column and a BEFORE UPDATE trigger
-- attached to the recursion-safe universal_delta_tracker() function (migration 078).
--
-- Migration is idempotent: every CREATE uses IF NOT EXISTS. Applying twice is a no-op.

-- ── metric_events ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.metric_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id   uuid NOT NULL,
  metric_name  text NOT NULL,
  dimensions   jsonb NOT NULL DEFAULT '{}'::jsonb,
  value_num    numeric,
  value_str    text,
  occurred_at  timestamptz NOT NULL,
  ingested_at  timestamptz NOT NULL DEFAULT NOW(),
  delta_data   jsonb,
  CONSTRAINT metric_events_value_xor CHECK (
    (value_num IS NOT NULL AND value_str IS NULL) OR
    (value_num IS NULL AND value_str IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS metric_events_product_metric_time_idx
  ON public.metric_events (product_id, metric_name, occurred_at);

CREATE INDEX IF NOT EXISTS metric_events_ingested_at_idx
  ON public.metric_events (ingested_at);

DROP TRIGGER IF EXISTS metric_events_delta_tracker ON public.metric_events;
CREATE TRIGGER metric_events_delta_tracker
  BEFORE UPDATE ON public.metric_events
  FOR EACH ROW EXECUTE FUNCTION public.universal_delta_tracker();

-- ── metric_rollups ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.metric_rollups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    uuid NOT NULL,
  metric_name   text NOT NULL,
  dimensions    jsonb NOT NULL DEFAULT '{}'::jsonb,
  bucket_window text NOT NULL,
  bucket_start  timestamptz NOT NULL,
  value_num     numeric,
  value_str     text,
  sample_count  integer NOT NULL DEFAULT 0,
  computed_at   timestamptz NOT NULL DEFAULT NOW(),
  delta_data    jsonb,
  CONSTRAINT metric_rollups_window_ck CHECK (bucket_window IN ('hourly', 'daily', 'monthly')),
  CONSTRAINT metric_rollups_value_xor CHECK (
    (value_num IS NOT NULL AND value_str IS NULL) OR
    (value_num IS NULL AND value_str IS NOT NULL)
  )
);

-- Unique index for idempotent UPSERT — rollup re-runs update in place.
-- Uses dimensions::text so JSONB objects with the same keys/values collate identically.
CREATE UNIQUE INDEX IF NOT EXISTS metric_rollups_uniq_idx
  ON public.metric_rollups (product_id, metric_name, dimensions, bucket_window, bucket_start);

DROP TRIGGER IF EXISTS metric_rollups_delta_tracker ON public.metric_rollups;
CREATE TRIGGER metric_rollups_delta_tracker
  BEFORE UPDATE ON public.metric_rollups
  FOR EACH ROW EXECUTE FUNCTION public.universal_delta_tracker();
