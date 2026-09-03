# Target architecture

This is the canonical description of how nutrition-mcp is shaped today, how to
run it locally, and where it is going. README and `CLAUDE.md` point here; they
do not duplicate this plan.

## Thesis

The homeserver Postgres mode is the target architecture, not a side path. One
Bun + Hono process serves the static site, OAuth, and `/mcp` from a single
container. Production today still runs Supabase (GoTrue + Storage + PostgREST);
local Compose and any future AWS deployment run the Postgres backend
(`DATABASE_URL` set, `SUPABASE_SECRET_KEY` unset) and do **not** recreate
Supabase's services on AWS.

## Current shape (as-is)

Hono runs on `Bun.serve` at port 8080, `hostname: "0.0.0.0"`,
`idleTimeout: 120` — `src/index.ts`.

`/mcp` is registered with `app.all` behind `banRepeatAuthFailures` →
`authenticateBearer` → `rateLimit` — `src/index.ts`. `handleMcp` answers
non-`POST` with a JSON-RPC 405 — `src/mcp.ts`. The transport is stateless:
`sessionIdGenerator: undefined`, a fresh `McpServer` per request, and nothing
to drain on `SIGTERM` — `src/mcp.ts`, `src/index.ts`.

Backend selection is `isPostgresBackend()` in `src/pg.ts` (`DATABASE_URL` set
and `SUPABASE_SECRET_KEY` unset). The shim answers the Supabase surface
(`from().select()…`, `auth`, `storage`, `rpc`) so nothing above
`src/supabase.ts` knows which backend it is talking to. That client is handed
back as `createPgClient() as unknown as SupabaseClient` in `src/supabase.ts`,
so `bun run typecheck` cannot see the shim.

OAuth authorization codes, access tokens, and refresh tokens live in Postgres
tables (`auth_codes`, `oauth_tokens`, `refresh_tokens` in
`schema/postgres.sql`); the ~10-minute login dance is an in-memory `sessions`
Map — `src/oauth.ts`.

Rate limiting and the strike-based IP ban are in-process Maps —
`src/rate-limit.ts`.

Exports: Supabase Storage in production; in Postgres mode, files under
`EXPORTS_DIR` served through an HMAC-signed token route `GET /exports/:token`
— `src/pg.ts` (`storageFrom`, `signExportToken`), `src/index.ts`.

`getBaseUrl` in `src/url.ts` derives the public origin from
`X-Forwarded-Proto` and `X-Forwarded-Host`, falling back to `Host`. OAuth
discovery advertises that origin — `src/discovery.ts`.

Container: `Dockerfile` (`oven/bun:1`, `bun --smol`, non-root `bun` user, port
8080). Local stack: `docker-compose.yml` (Postgres 16 + app, bound to
`127.0.0.1:8080`, one replica by design — the compose header says not to
scale). Today's production is DigitalOcean App Platform; merge-to-`main`
auto-deploys — `.github/workflows/ci.yml`.

## Running it locally

Copy `.env.example` to `.env`, fill `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET`,
then `docker compose up -d --build`. Point MCP Inspector at
`http://127.0.0.1:8080/mcp`.

Known friction:

- **No hot reload inside Compose.** The image runs `bun --smol src/index.ts`
  (`Dockerfile`). Use `bun run dev` on the host for the hot-reload path.
- **`schema/postgres.sql` is an init script.** Compose mounts it as
  `/docker-entrypoint-initdb.d/01-schema.sql` (`docker-compose.yml`); Postgres
  only runs that when the `pgdata` volume is first created. On an existing
  volume: `psql "$DATABASE_URL" -f schema/postgres.sql`.
- **A leftover `SUPABASE_SECRET_KEY` in `.env` silently disables Postgres
  mode** for `bun run dev`. `isPostgresBackend()` treats any set secret key as
  Supabase — `src/pg.ts`. Compose already forces `SUPABASE_SECRET_KEY` empty
  (`docker-compose.yml`).
- **`OFF_USER_AGENT` is only needed for `lookup_barcode`.** Open Food Facts
  rejects requests without it — `src/foods.ts`.
- **Claude.ai still needs an HTTPS tunnel.** OAuth discovery must advertise a
  public `https://` origin (`src/discovery.ts`, `src/url.ts`); a loopback
  `http://` origin makes the login dance fail.

## Target: AWS with ordinary services

| Concern  | Service                 | Rationale                                                                                                                                                                                                                                                             |
| -------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compute  | ECS Fargate behind ECR  | Run the existing `Dockerfile`; one task is the site, OAuth, and `/mcp`.                                                                                                                                                                                               |
| Ingress  | ALB + ACM + Route 53    | TLS at the load balancer; health check `GET /health`; raise the ALB idle timeout above the 60s default so long POSTs survive (the app sets `idleTimeout: 120` in `src/index.ts`).                                                                                     |
| Database | RDS PostgreSQL 16       | Apply `schema/postgres.sql`.                                                                                                                                                                                                                                          |
| Auth     | In-app OAuth            | Stays the implementation in `src/oauth.ts`; not an AWS identity service.                                                                                                                                                                                              |
| Exports  | S3                      | Through the `storage` shim in `src/pg.ts` (`storageFrom` is the seam). `bun run typecheck` cannot see this shim (`createPgClient() as unknown as SupabaseClient` in `src/supabase.ts`) — an S3 change is not a config switch; it is an edit typecheck will not catch. |
| Secrets  | Secrets Manager         | Injected as task-definition secrets.                                                                                                                                                                                                                                  |
| Logs     | CloudWatch              | Container logs from the Fargate task.                                                                                                                                                                                                                                 |
| CI       | Existing GitHub Actions | Extend `.github/workflows/` to build → ECR → update the ECS service.                                                                                                                                                                                                  |

Start at `desiredCount = 1`.

**SECURITY:** `getBaseUrl` trusts forwarding headers unconditionally
(`src/url.ts`), so the ALB must be the only path to the task port. A client
that can hit the task directly can spoof `X-Forwarded-Proto` /
`X-Forwarded-Host` and make discovery advertise an origin it does not control.

## Explicitly not used

- **Lambda** — long-lived POSTs and a container that already exists.
- **API Gateway** — same: long-lived POSTs and a container that already exists.
- **EKS** — operational weight the workload does not need.
- **Cognito** — the server is its own OAuth authorization server; swapping it
  re-plumbs `src/oauth.ts` and the discovery documents (`src/discovery.ts`).
- **Aurora Serverless** — a plain relational schema with two hand-maintained
  copies, not a serverless-SQL product.
- **DynamoDB** — same: the data model is relational (`schema/postgres.sql`).
- **App Runner** — sunset.
- **sticky sessions** — not a substitute for moving the login `sessions` Map;
  that hides the problem instead of fixing it.

## Backend freeze for AWS

AWS runs the Postgres copy of the schema. Do not apply the GoTrue / RLS /
Storage migrations under `supabase/migrations/` to an RDS instance;
`schema/postgres.sql` is the file, and Postgres mode carries its own `users`
table where Supabase has `auth.users`.

A schema change is both files. `src/schema-parity.test.ts` fails when a table
or column exists in the migrations but not in the flat schema.

## Before more than one task

Single-instance state, in priority order:

1. Persist the OAuth login `sessions` Map as a Postgres row alongside
   `auth_codes` (`src/oauth.ts`, `schema/postgres.sql`). Until that lands, a
   second task drops in-flight logins.
2. Move exports to S3 so a signed link is not tied to one task's disk
   (`src/pg.ts` `storageFrom`).
3. Rate-limit and ban Maps can wait (`src/rate-limit.ts`). WAF or a shared
   store later; the failure mode is a laxer limit, not a broken login.

Until the first two are done, `desiredCount` stays 1 — the same constraint as
the `docker-compose.yml` header.

## Not provisioned yet

The repo intentionally contains no IaC. This document is the specification a
future change implements.
