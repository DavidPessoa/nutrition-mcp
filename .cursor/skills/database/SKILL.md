---
name: database
description: Dual-backend Postgres/Supabase work for nutrition-mcp. Use when adding migrations, tables, columns, indexes, RLS, or changing src/pg.ts SQL behavior. Keep supabase/migrations and schema/postgres.sql equivalent.
disable-model-invocation: true
paths:
    - supabase/**
    - schema/**
    - src/pg.ts
    - src/pg.test.ts
---

# Database

Two backends, one product. Hosted path is Supabase + RLS. Homeserver path is `DATABASE_URL` + `schema/postgres.sql` + `src/pg.ts`. A change that lands on only one of them is a bug.

## What you own

- `supabase/migrations/*.sql` — additive production migrations
- `schema/postgres.sql` — flattened homeserver schema (must match migrated Supabase)
- `src/pg.ts` / `src/pg.test.ts` — query layer, identifier checks, numeric coercion
- RLS / grants only in the Supabase migration, never in `schema/postgres.sql` (the app is the only homeserver client)

Do not register MCP tools or edit widget HTML unless the plan listed those files.

## Migration recipe

1. Read the current table in `schema/postgres.sql` and the latest related migration.
2. Add `supabase/migrations/YYYYMMDDHHMMSS_short_name.sql` (UTC timestamp prefix, matching existing files).
3. Apply the same shape to `schema/postgres.sql`.
4. Prefer `add column if not exists` / additive nullable columns. Production already has data.
5. Encode floor vs ceiling in the column name (`min_*` / `max_*`). Do not leave direction as an app-only convention.
6. `timestamptz`, not `timestamp`. User-owned rows keep `user_id` with `ON DELETE CASCADE`.
7. Idempotency: unique `(user_id, idempotency_key)` where the key is not null, same as meals/water/weight.
8. No hardcoded nutrient reference-intake defaults. `NULL` means "not set".
9. If a new `numeric` column does not match `src/pg.ts`'s `NUMERIC_COLUMN` regex (`_(g|mg|mcg|ml|ms|days)$` or calories), extend that allow-list in `src/pg.ts` and test it. Do not coerce arbitrary text columns.

## RLS (Supabase only)

User data is per-user. Policies must not let one `user_id` read another. Service-role policies are already restricted — do not re-open them. See `supabase/migrations/20260726130000_restrict_service_role_policies.sql`.

## Query layer

`src/pg.ts` is a PostgREST-shaped wrapper. Identifiers go through `ident()` (`/^[a-z_][a-z0-9_]*$/i`). Do not concatenate SQL. Pagination/export paths that list "all rows" must not silently stop at 1000 — the export tools reconcile against an exact count and throw when short.

## Tests

- `bun test src/pg.test.ts`
- If you changed numeric coercion or filters, add a case.
- You cannot apply Supabase migrations in this skill unless the environment has credentials; still keep SQL valid and equivalent across the two schema files.

## Report

Files changed, migration filename, `schema/postgres.sql` updated (yes/no), `src/pg.ts` updated (yes/no), tests run, anything the reviewer should distrust.
