# ADR-001 — Thin Raw-SQL Migration Runner

**Date:** 2026-06-12  
**Status:** Accepted  
**Story:** HUB-49

## Context

The HUB service needs a reliable way to evolve the PostgreSQL schema over time. Standard ORMs (Drizzle, Prisma, TypeORM) and framework-based runners (Flyway, Liquibase) add dependencies and abstractions that conflict with the project's raw-`pg`-pool constraint documented in I-1 Risk §12.

## Decision

Implement a minimal, in-process SQL file runner (`src/db/migrate.ts`) that:

1. Uses a dedicated `pg.Client` (not the shared pool) so it can open admin transactions safely.
2. Reads `.sql` files from `db/migrations/` in **lexicographic order** — filenames are prefixed `NNN_` to enforce ordering.
3. Wraps each file in a single `BEGIN / COMMIT` transaction; rolls back and re-throws on any error.
4. Tracks applied files in a `schema_migrations` table (bootstrapped inline before reading SQL files).
5. Skips already-applied files (idempotent re-runs).
6. Logs all activity via Pino; `DATABASE_URL` is never written to logs.
7. Exits with code 1 when called from the CLI (`npm run migrate`) and a migration fails.

## Exceptions to the `universal_delta_tracker` Rule

Two tables are **exempt** from the `delta_data` column and `universal_delta_tracker` trigger requirement:

- **`schema_migrations`** — infrastructure table; its mutations are the migrations themselves, tracked by filename + timestamp; a separate audit column would be circular.
- **`delta_log`** — the audit log itself; attaching an audit trigger to the audit table would create infinite recursion.

All other HUB tables must have `delta_data JSONB` and have the `universal_delta_tracker` trigger applied (see HUB-51).

## Consequences

- No ORM dependency in the migration path.
- SQL files are plain PostgreSQL — no dialect translation layer.
- Developers add a new migration by creating a sequentially-named `.sql` file; no code-gen step required.
- The runner is testable against a real database (see `src/db/__tests__/migrate.integration.test.ts`).
