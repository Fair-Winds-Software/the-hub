-- Authorized by HUB-1699 (E-BE-1 S22) — expand advisor_outcome_type with operator-captured
-- semantics: won (operator confirmed close), lost (operator confirmed loss), no_action
-- (operator explicitly declined to act). Preserves existing applied/dismissed/auto_detected
-- (auto-detection semantics). Backward-compatible: existing rows remain valid.
--
-- Spec deviation: R2 D-HUB-SCOPE-036 locked migration 050, originally cited 049. Both
-- numbers are consumed (049_role_rename_step2, 050_role_rename_step3) by the HUB-1587
-- chain. Using next available number (055) per the established "next-available + document"
-- pattern (mirrors HUB-1697's 053 + HUB-1698's 054).
--
-- PG note: ALTER TYPE ... ADD VALUE is non-destructive and transaction-safe in PG 12+. The
-- new values are NOT usable within the same transaction that added them, but the next
-- transaction (and all subsequent reads) sees them — which is what the HUB-1561 outcome
-- write paths and HUB-1699's list endpoint rely on.

ALTER TYPE advisor_outcome_type ADD VALUE IF NOT EXISTS 'won';
ALTER TYPE advisor_outcome_type ADD VALUE IF NOT EXISTS 'lost';
ALTER TYPE advisor_outcome_type ADD VALUE IF NOT EXISTS 'no_action';
