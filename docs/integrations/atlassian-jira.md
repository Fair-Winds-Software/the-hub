# Atlassian Jira Integration — Operator Runbook

> Authorized by HUB-1592 (E-BE-1 S9, CR-1). Decision: **D-HUB-SCOPE-029** locks Atlassian Cloud REST v3 Basic auth (base64("email:token"), not Bearer).

The Jira integration lets HUB surface per-product **open CR count** and **open Bug count** on the Operator Console dashboard (HUB-1562). HUB authenticates as a single service account against Atlassian Cloud REST v3, queries the project mapped to each HUB product, and caches the result in Redis (5–15 min TTL — HUB-1593).

## Provisioning the service account

1. **Create the account.** In Atlassian Admin (https://admin.atlassian.com), create a dedicated service-account user — name it `hub-service-readonly` (or similar). Give it an email like `hub-service@fairwindssoftware.com`.

2. **Grant read access to every project HUB queries.** At minimum: CH (ContentHelm), HUB (this repo), SYNC (Synapz), LK (LaunchKit). Add new HUB-tracked products' projects as they come online — update the mapping (below) and grant read at the same time. **Read-only** — HUB never writes to Jira.

3. **Generate an API token.**
   - Sign in to https://id.atlassian.com/manage-profile/security/api-tokens **as the service account** (not your personal account).
   - Click **Create API token**.
   - Label: `hub-prod-YYYYMM` (e.g., `hub-prod-202607`).
   - Copy the token immediately — Atlassian only shows it once.

4. **Store in production env.**
   ```bash
   JIRA_SERVICE_EMAIL=hub-service@fairwindssoftware.com
   JIRA_SERVICE_TOKEN=<the token from step 3>
   ```
   Both env vars are validated at startup by `src/config/env.ts`. Missing either → process exits.

5. **Vault.** Add both values to 1Password under `Fair Winds → HUB → Atlassian Service Account`. Tag with the labelled token name (`hub-prod-202607`) so rotation is auditable.

## Authentication model (D-HUB-SCOPE-029)

Atlassian Cloud REST v3 uses **Basic auth**, NOT Bearer:

```
Authorization: Basic <base64("${JIRA_SERVICE_EMAIL}:${JIRA_SERVICE_TOKEN}")>
Accept: application/json
```

HUB constructs this header server-side in `jiraIntegrationService` (HUB-1593). Token never leaves the BE process; FE never sees it.

## Product → Project mapping

HUB resolves which Atlassian project to query per HUB-tracked product via the `settings` row `jira_project_key_by_product` (seeded by migration `052_jira_project_mapping.sql`):

```json
{
  "contenthelm": "CH",
  "hub": "HUB",
  "synapz": "SYNC",
  "launchkit": "LK"
}
```

**Adding a new product:** an operator with `super_admin` updates this row via the Settings UI (HUB-1664) — no code change. Document the new HUB product key → Atlassian project key pair in the next rotation runbook.

**Removing a product:** drop the key from the JSON object. `jiraIntegrationService` ignores HUB products with no mapping (no Jira tile rendered on the dashboard for that product).

## 90-day rotation

The Atlassian API token is rotated every 90 days at minimum, ideally aligned to the calendar quarter.

**Procedure:**

1. **Generate the new token** (steps 1–3 above with a fresh label, e.g., `hub-prod-YYYYMM`).
2. **Stage in production env** — temporarily, add `JIRA_SERVICE_TOKEN_NEXT=<new>` alongside the existing `JIRA_SERVICE_TOKEN`. v0.1 does not support dual-token verification (single-tenant scale; small operator team). The replacement procedure is "schedule a 60-second deploy window, swap the env var, restart."
3. **Schedule the swap.** Pick a low-activity window. Update `JIRA_SERVICE_TOKEN` in production env. Restart HUB.
4. **Verify.** Hit `GET /api/v1/admin/integrations/jira/tickets?productId=<id>` against a known product. A 200 with non-empty `{openCRs, openBugs}` confirms the new token works. A 401 means the new token is bad — re-check Atlassian admin.
5. **Revoke the old token.** In Atlassian admin (signed in AS the service account), delete the previous token. Confirms forward-secrecy.
6. **Update the 1Password entry** with the new label.

**JWT signing-key-rotation analogue:** Like the role-rename window (HUB-1588), do NOT rotate the JWT signing key during the same maintenance window as the Atlassian token swap. One change at a time.

## Failure modes & operator response

| Symptom | Cause | Action |
|---|---|---|
| Startup exits with `Missing required environment variables: JIRA_SERVICE_TOKEN` | Env var not set | Set the env var (see step 4 above) |
| Startup exits with `Missing required environment variables: JIRA_SERVICE_EMAIL` | Email pair missing | Set both vars (Atlassian requires the email half of the Basic-auth pair) |
| Dashboard tile renders "Ticket counts unavailable" | jiraIntegrationService 429 (rate limit) or 5xx from Atlassian | Wait — Redis cache (5–15 min TTL) absorbs short outages. If persistent: check Atlassian status, verify token is not revoked. |
| Dashboard tile renders zeros for a product that obviously has open CRs | Mapping incorrect; queried wrong project | Edit `settings.jira_project_key_by_product` (or correct the Atlassian project key) |
| 401 from `/api/v1/admin/integrations/jira/tickets` | Token revoked, expired, or wrong | Generate a new token and rotate (procedure above) |

## Test/dev environment

Tests and local dev use the placeholder values:

```
JIRA_SERVICE_EMAIL=ci-test-jira@hub.invalid
JIRA_SERVICE_TOKEN=test-jira-token-placeholder
```

These satisfy `validateEnv()` startup but will fail at actual fetch time — HUB-1593 caches & error-handles that path. No real Atlassian calls are made from CI or unit tests.

## Cross-references

- `src/config/env.ts` — startup validation
- `src/types/settingsCatalog.ts` — mapping registered as `jira_project_key_by_product` (type `json`)
- `db/migrations/052_jira_project_mapping.sql` — seed row
- `.env.example` — required env vars
- HUB-1593 — `jiraIntegrationService` + Redis cache
- HUB-1594 — `GET /api/v1/admin/integrations/jira/tickets` endpoint

— Sammy Hoelscher · 2026-06-27 (HUB-1592 close)
