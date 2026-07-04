# The HUB

Central control plane for the Maverick Launch / Fair Winds Software portfolio. The HUB is the single internal service every Fair Winds product (Synapz, Social Squeeze, LaunchKit, ContentHelm, and others) connects to for subscription state, signed-lease enforcement, usage tracking, billing events, kill-switch enforcement, and cost calculation. Products embed the HUB Client SDK; the HUB itself is internal-only (no external tenant users).

Stack: Node.js 20+, TypeScript (strict ESM), Fastify, PostgreSQL (raw `pg` pool — no ORM), BullMQ + Redis, Stripe.

## Infrastructure

Canonical SSoT for everything this project depends on. Maintained by `/infra-audit`.

| Resource | Location | Status |
|---|---|---|
| Confluence space | https://fairwindssoftware.atlassian.net/wiki/spaces/HUB/overview?homepageId=474939684 | ✅ Active |
| Jira project | [HUB](https://fairwindssoftware.atlassian.net/jira/software/c/projects/HUB/list) | ✅ Active |
| GitHub repo | [Fair-Winds-Software/the-hub](https://github.com/Fair-Winds-Software/the-hub) | ✅ Active (you are here) |
| Postgres (local) | docker-compose service `postgres` (container `hub_postgres`) on `localhost:${POSTGRES_PORT:-5432}` — HUB defaults to canonical 5432 per D-FW-INFRA-002 (HUB is the spine). DB `hub_dev`, user `hub`. | ✅ Active (postgres:17-alpine) |
| Postgres (AWS Dev) | Not yet provisioned | ⏳ Pending AWS setup |
| Postgres (AWS UAT) | Not yet provisioned | ⏳ Pending AWS setup |
| Postgres (AWS Prod) | Not yet provisioned | ⏳ Pending AWS setup |
| Redis | docker-compose service `redis` (container `hub_redis`) on `localhost:${REDIS_PORT:-6379}` — HUB defaults to canonical 6379 per D-FW-INFRA-002 | ✅ Active (redis:7-alpine) |
| Adminer (DB UI) | docker-compose service `adminer` (container `hub_adminer`) on `http://localhost:${ADMINER_PORT:-8080}` — HUB defaults to canonical 8080 per D-FW-INFRA-002. Auto-fills server=postgres at login. | ✅ Active (adminer:latest) |
| Docker | `docker-compose.yml` at repo root | ✅ Active |
| HUB connection | — (HUB IS the spine; doesn't license itself) | N/A |
| Project type | `full-stack-saas` minus the HUB Connection phase (HUB is the spine) | — |

### Local development

```bash
docker-compose up -d         # Start postgres + redis + adminer
npm install
cp .env.example .env         # Dev defaults filled in — no edits needed for local Docker stack
npm run migrate              # Apply all 45 SQL migrations
                             # (seeds the Maverick Launch internal tenant via migration 001 INSERT)
npm start                    # Boot the API (validateEnv() enforces all required env vars at startup)
```

Open Adminer at http://localhost:8080 (system: PostgreSQL, server: postgres, user: hub, password: hub, database: hub_dev).

**Required env vars** (enforced by `validateEnv()` at startup — all pre-filled with dev defaults in `.env.example` per HUB-1548):

- `DATABASE_URL`, `REDIS_URL` — matches the Docker stack out of the box
- `JWT_SECRET`, `OPERATOR_JWT_SECRET` — token-signing secrets (dev defaults in `.env.example`; replace for prod)
- `LEASE_ENCRYPTION_KEY`, `HOOK_ENCRYPTION_KEY` — 64 hex chars each (dev defaults are all-zero placeholders; regenerate for prod via `openssl rand -hex 32`)
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SIGNING_SECRET` — dev placeholders; real values from Stripe dashboard for prod
- `JIRA_SERVICE_TOKEN`, `JIRA_SERVICE_EMAIL`, `JIRA_WORKSPACE_URL` — Atlassian Cloud Basic-auth pair; dev placeholders will 401 against Atlassian but the app boots + non-Jira endpoints work

`cp .env.example .env && npm start` works against a fresh Docker stack. Every DEV-ONLY value in `.env.example` is clearly marked and must be replaced before deploying to production.

**Migration runner note:** `src/db/migrate.ts` applies all SQL files in `db/migrations/` lexicographically. Migration `041_audit_log.sql` includes an idempotent `CREATE ROLE hub_app` guard (commit `7972b5e`) so re-runs against existing roles don't fail.

**Why Docker:** Before 2026-06-20, HUB ran a native Windows `postgresql-x64-17` install. The local DB drifted out of sync with the migration tracking table (44 migrations recorded as applied, only 8 of ~67 tables actually present). `/infra-audit` resolved the drift by migrating into Docker and running all migrations against a fresh DB. See the HUB Decision Log for full context.
