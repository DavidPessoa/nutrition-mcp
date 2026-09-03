---
name: review
description: Independent review of nutrition-mcp changes. Use after implementation and after each fix round. Checks code quality, security, and whether the change makes sense. Feature is not done until APPROVE with zero blocking findings.
disable-model-invocation: true
---

# Review

You are the gate. Read `CLAUDE.md`, the plan, and the real diff. Run or read tests. Do not implement. Do not commit.

A clean bill of health with no inspection list is a failed review. Say what you opened.

## Verdict (required)

End with exactly one of:

```markdown
## Verdict

APPROVE
<summary in one sentence>
```

or

```markdown
## Verdict

REQUEST CHANGES

### Blocking

- `<file>:<line>` — <problem>. <what to change>.

### Non-blocking

- `<file>:<line>` — <problem>. <optional fix>.
```

`APPROVE` is allowed only with zero blocking findings. The orchestrator will not open the PR otherwise. You do not create the PR.

Tests are a hard gate. `APPROVE` is forbidden unless `bun run format:check`, `bun run typecheck`, and `bun test` are all green in output the reviewer either ran or was given verbatim.

Blocking: incorrect behavior, security, dual-backend drift, missing tests for a new branch, broken widget handshake, CLAUDE.md landmine, `outputSchema` holes, silent data loss, prove output that is missing, stale relative to the diff, or shows any failure.

Non-blocking: style nits that Prettier does not settle, optional refactors, naming taste. Do not inflate these into blockers.

## Inspect

### Makes sense

- Diff matches the plan's goal and stays inside out-of-scope.
- Names and types match how the rest of the server talks (nutrient field names, `min_`/`max_` goals, meal types).
- Failure modes are explicit. No swallowed errors, no "success" analytics on a failed import.

### Quality

- Smallest change that works. No new abstraction for a one-call site.
- Tests assert behavior, not that a function was called. New logic has a test next to it.
- `bun run format:check`, `bun run typecheck`, and `bun test` actually run in this review (or you quote the orchestrator's verbatim output and say you relied on it).
- Prettier-clean. No leftover debug. No commented-out code.

### Security

- Every user-data query is scoped by the authenticated `user_id`. No IDOR via meal/goal/export ids.
- No secrets in the diff (`.env`, keys, tokens). Export URLs stay signed and time-limited.
- SQL identifiers stay on the `ident()` allow-list. No string-built SQL.
- Auth cookies/headers, OAuth tokens, and rate limits are not weakened.
- Widget JS: no `eval`, no new network destinations, inbound `postMessage` still requires `event.source === host`.
- `delete_account` / analytics do not re-attach a deleted user's id.

### Dual backend and landmines

- Schema: migration **and** `schema/postgres.sql` when columns/tables change.
- `src/pg.ts` numeric allow-list if a new numeric column would otherwise stay a string.
- Timestamps through `parseLoggedAt` / `resolveWriteLoggedAt`.
- Import idempotency keys and `source_id` uuid rules unchanged unless the plan is about them.
- `meals.csv` headers still match the importer. Export still includes alcohol regardless of the display opt-in.
- Tools with `outputSchema` return complete objects (explicit `null`s) on every path. No `isError` on structured-report tools.
- Widgets: `initialized` notification, `size-changed`, shared partials not forked.
- No version bump unless the plan is a registry publish.

## Output shape

```markdown
## Inspected

- files / commands

## Findings

<none, or the blocking/non-blocking lists>

## Tests

Name the exact commands (`bun run format:check`, `bun run typecheck`, `bun test`) and their pass/fail outcome.

## Verdict

...
```
