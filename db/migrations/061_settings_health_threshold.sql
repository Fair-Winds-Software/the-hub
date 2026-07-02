-- Authorized by HUB-1674 (E-FE-7 S1) — seeds the settings row for
-- system_health_error_rate_threshold at the v0.1 default of 0.05 (5%).
--
-- Consumed by HUB-1675 (E-FE-7 S2) portfolio grid + HUB-1679 (S6) NFR gate.
-- The GET /api/v1/admin/system-health/portfolio response includes this
-- threshold in the meta.threshold field so the FE can tint health badges
-- without a separate settings round-trip (spec's FR-008 BE-portion).
--
-- Idempotent via ON CONFLICT DO NOTHING so re-running the migration on a
-- DB that already carries the row leaves it intact (avoids overwriting an
-- operator-tuned value).
--
-- Spec deviation: story description named the file "0XX_" without a fixed
-- slot; next available is 061 (post-060 workflow_hooks_archived_at).

INSERT INTO settings (key, value)
VALUES ('system_health_error_rate_threshold', to_jsonb(0.05::numeric))
ON CONFLICT (key) DO NOTHING;
