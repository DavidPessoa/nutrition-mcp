---
name: backend
description: MCP server and Bun/TypeScript implementation for nutrition-mcp. Use when adding or changing tools, handlers, auth, import/export, analytics, timezones, or src/*.ts tests.
disable-model-invocation: true
paths:
    - src/**/*.ts
    - server.json
---

# Backend

Bun + TypeScript. Entry `src/index.ts`. Tools in `src/mcp.ts`. Data through `getSupabase()` — that function already switches on Postgres vs Supabase. Do not fork handlers with `isPostgresBackend()`.

Read `CLAUDE.md` for import, export, and timestamp landmines before touching those paths.

## What you own

Whatever the plan listed, typically:

- `src/mcp.ts` + `src/mcp.test.ts`
- Domain modules (`src/import.ts`, `src/export.ts`, `src/tz.ts`, `src/analytics.ts`, …) and their tests
- Tool wiring, `outputSchema`, `structuredContent`, widget `_meta.ui.resourceUri` (not the HTML)

Leave migrations and widget source to those specialists unless assigned. `src/*.test.ts` is backend. Widget tests under `public/widgets/**` belong to frontend.

## New or changed tools

- Register on `registerTools`. Descriptions are production copy — hosts show them to models.
- Return `structuredContent` on **every** path when the tool declares `outputSchema`. Nullable fields need explicit `null`s; `.nullable()` is not optional.
- Widget-backed tools: `_meta.ui.resourceUri` plus identical `"openai/outputTemplate"`, gated by `uiMeta()` / `widgetsEnabled`.
- Bounds that would be "the caller's usual mistake" belong in the handler, not Zod, when a schema reject would drop the structured report (see `bulk_import_meals`).
- Do not set `isError` on tools whose product is a structured report. Use `status: "failed"` inside the schema. `withAnalytics` needs an `outcome` callback so failures are not logged as successes.
- Analytics: wrap with `withAnalytics`. `delete_account` uses `DELETED_ACCOUNT_ANALYTICS_ID`.

## Time and identity

- Writes resolve `logged_at` through `parseLoggedAt` / `resolveWriteLoggedAt` (`src/tz.ts`). Offset-less local time is resolved in the profile timezone. Never insert an offset-less string into `timestamptz`.
- Manual writes vs import have different future/past bounds; do not copy the importer's window onto `log_meal`.
- Bucket reads by `dateInTz`. An unconfigured timezone is UTC; warn when the profile row is missing.

## Import / export (do not reinvent)

- One import write path (`src/import.ts`). Keys are `import:<digest>:<ordinal>`. Our own export re-imports by uuid `source_id`. See CLAUDE.md "Bulk meal import".
- One export tool: `export_all_data`. Do not add a meals-only export. CSV headers on `meals.csv` are importer aliases — renaming them breaks re-import.

## Tests and runtime

```bash
bun test src/<file>.test.ts
bun run typecheck
```

`bun run typecheck` covers `src/` only. Handler return shapes that must match `outputSchema` need a serializer test (see `src/import.test.ts`).

Default to Bun APIs. `bun:test`. Four-space Prettier. Do not add Node-only libraries when Bun already has the primitive.

Do not bump versions in `package.json` / `src/mcp.ts` / `server.json` unless the plan is a registry publish.

## Report

Files changed, tools touched, tests run, outputSchema completeness, landmines handled.
