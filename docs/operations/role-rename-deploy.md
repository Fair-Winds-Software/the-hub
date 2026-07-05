# Role Rename Deploy Runbook — `tenant_admin` → `product_admin`

> **Authorized by HUB-1588** (E-BE-1 S5, CR-4) for the v0.1 launch deploy. Future role
> renames follow the same widen-mutate-narrow pattern; clone this runbook with the new
> role names + a fresh compat flag key.

This runbook covers the operator deploy that ships the CR-4 role rename to production. It
assumes the migrations in HUB-1586 (S3 — 048/049/050), the src rename in HUB-1587 (S4),
and the backward-compat window in HUB-1588 (S5) are all merged on the deploy branch.

## Pre-deploy checklist

1. **JWT signing key MUST NOT rotate during this deploy window.** A rotation invalidates
   every in-flight JWT — including the ones the compat window is designed to keep alive.
   If the rotation calendar lands in the next 24 hours, postpone the rename or postpone
   the rotation by 25 hours.
2. **Confirm `settings.role_rename_compat_window_enabled` is seeded** to `true` by
   migration `047_settings_seeds.sql` (HUB-1585).
3. **Confirm the migration runner has not yet applied** `050_role_rename_step3.sql` — the
   pre-deploy state must accept either role string at the DB level.

## Deploy

1. Merge the deploy branch to `main`. CI runs the `tenant_admin rename gate` (HUB-1587) and
   the migration tests.
2. The deploy pipeline runs `npm run migrate` which applies migrations 048 (widen CHECK)
   → 049 (UPDATE + audit emit via CTE) → 050 (narrow CHECK) sequentially in a single runner
   invocation (≈ 10 ms for all three on an empty `operator_accounts` table; longer in
   production with non-trivial row counts but still sub-second).
3. The HUB process restarts with the new code that:
   - Mints `product_admin` JWT claims exclusively (HUB-1587 src rename + HUB-1586 DB column)
   - Accepts BOTH `product_admin` and legacy `tenant_admin` JWT claims via the compat
     window (HUB-1588 `operatorRbacHook`)

## Compat window monitoring (~24 hours)

Tail the structured log for the telemetry counter:

```bash
# Production stream (Pino JSON lines)
journalctl -u hub -f | jq 'select(.event == "jwt.legacy_claim_accepted")'
```

Each line corresponds to one legacy claim acceptance. Expected pattern:

- **Minutes 0–15** (one access-token TTL): counter increments as in-flight operator
  sessions submit requests carrying the legacy claim. Volume ≈ active operator count
  × request rate.
- **Minutes 15–30** (two TTL window): counter drops to ~0 as access tokens expire and
  refresh tokens rotate via `POST /api/v1/admin/auth/refresh`, which mints new
  `product_admin` claims.
- **Minutes 30+:** counter should stay at 0.

## Flip the compat flag

Once the counter has been 0 for ≥ 30 minutes (≈ 2× access-token TTL) wall-clock:

```sql
UPDATE settings
   SET value = 'false'::jsonb, updated_at = NOW()
 WHERE key = 'role_rename_compat_window_enabled';
```

Verify the flip via Redis cache:

```bash
redis-cli GET 'hub:settings:role_rename_compat_window_enabled'
# expected: false
```

(The `updateSetting()` API does this end-to-end including the Redis write; `UPDATE`
directly is only safe if Redis is then `DEL`d or its TTL is short.)

After flip, any residual legacy claim will receive HTTP 403 from the RBAC hook — the
compat window is closed.

## Alert on residual

If the counter is still > 0 at the 24h post-deploy mark, do NOT auto-flip. Instead:

1. Identify the offending operator(s) via the `operator_id` field in the log lines.
2. Manually rotate their refresh token: `POST /api/v1/admin/auth/refresh` from their
   client, or force re-login.
3. Re-tail logs for 30 minutes; if counter stays 0, proceed with the flip.

## Rollback

The compat flag itself is the rollback knob — re-set to `true` if the flip surfaces
unexpected 403s:

```sql
UPDATE settings SET value = 'true'::jsonb WHERE key = 'role_rename_compat_window_enabled';
```

Full migration rollback (un-rename) is **not recommended** post-deploy and is documented
in the per-file headers of migrations 048/049/050 only as a last resort.

## Automated flip (HUB-1707, v0.2+)

HUB-1707 landed the BullMQ automation the R1 amendments to HUB-1588 specified. From
v0.2 onwards this runbook's SQL-flip step is optional — the CRON job `role-rename-compat-flip`
fires every 5 minutes and closes the window automatically when either:

- **No legacy claim accepted for 30 min:** the flip trigger is recorded in `audit_log`
  as `new_values.trigger = 'no_legacy_claims_30m'`, actor
  `system:role-rename-window-closed`.
- **24 h have elapsed since the compat window started:** if the counter has stayed at
  0 through the window, the flip trigger is `24h_elapsed`. If residual claims were
  accepted, the CRON does NOT flip — instead it emits a compliance alert of type
  `residual_legacy_claim_after_window`. The operator resolves the residual and then
  flips the flag manually via the HUB Settings editor (the manual procedure above still
  applies as the operator override path).

The 24 h clock starts at the first CRON tick that observes the flag in an enabled state
(recorded to Redis at `hub:metrics:role_rename_compat_window:started_at`), so this
automation works whether the flag was seeded by migration 047 or flipped back to `true`
by an operator override at some later time.

After a successful flip the CRON tick calls `removeRepeatable(...)` on its own queue, and
`registerAllCronJobs` at the next worker restart observes the flag=false and skips
re-arming — so a re-deploy does not resurrect a stale schedule.

Manual SQL flip below remains valid as an override path when the operator decides to
close the window before the automation would (e.g., mid-day security drill).

---
*Last updated: 2026-07-05 by HUB-1707.*
