-- Authorized by HUB-46 FVL — C1: prune_audit_log SECURITY DEFINER function (hub_app DELETE revoked per R2)
-- Authorized by HUB-46 FVL — L1: ip_address column TEXT → INET for type-level validation
-- Note (L2): audit_log is the sole exception to the CLAUDE.md universal_delta_tracker trigger
--   requirement. Applying the trigger would cause infinite recursion: audit_log writes trigger
--   audit_log inserts → repeat. This is the only documented exception.

-- C1: SECURITY DEFINER function allows hub_app to prune aged audit rows without holding
-- DELETE privilege on audit_log directly. R2 (INSERT-only at the role level) is preserved;
-- deletion is mediated through this function whose owner holds the necessary right.
CREATE OR REPLACE FUNCTION prune_audit_log(retain_months INT)
  RETURNS INT
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public
AS $$
  WITH deleted AS (
    DELETE FROM audit_log
    WHERE created_at < NOW() - (retain_months || ' months')::INTERVAL
    RETURNING 1
  )
  SELECT COUNT(*)::INT FROM deleted;
$$;

GRANT EXECUTE ON FUNCTION prune_audit_log(INT) TO hub_app;

-- L1: Upgrade ip_address from TEXT to INET for strict IP validation and range-query support.
-- USING clause safely handles NULL and empty strings; will error on any stored non-IP text.
ALTER TABLE audit_log
  ALTER COLUMN ip_address TYPE INET
  USING CASE WHEN ip_address IS NULL OR ip_address = '' THEN NULL ELSE ip_address::INET END;
