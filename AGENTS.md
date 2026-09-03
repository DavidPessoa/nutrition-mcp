# nutrition-mcp agent team

This repo is a remote MCP server. Merging to `main` deploys production. Treat every feature as a release.

Operational invariants live in `CLAUDE.md`. This file is the team: who does the work, which model they use, and the gate that decides when a feature is done.

## Team

| Role      | Invoke       | Model                                                  | Writes?   | Owns                                                                          |
| --------- | ------------ | ------------------------------------------------------ | --------- | ----------------------------------------------------------------------------- |
| Architect | `/architect` | Claude Opus 5 High (`claude-opus-5[effort=high]`)      | Plan only | Decomposition, file ownership, sequence                                       |
| Database  | `/database`  | Grok 4.6 High Fast (`grok-4.6[effort=high,fast=true]`) | Yes       | `supabase/migrations/`, `schema/postgres.sql`, `src/pg.ts` query/SQL behavior |
| Backend   | `/backend`   | Grok 4.6 High Fast (`grok-4.6[effort=high,fast=true]`) | Yes       | `src/**/*.ts` except widget assembly, MCP tools, tests                        |
| Frontend  | `/frontend`  | Grok 4.6 High Fast (`grok-4.6[effort=high,fast=true]`) | Yes       | `public/widgets/`, `src/widgets.ts`, widget tests, style guide                |
| Reviewer  | `/reviewer`  | Claude Opus 5 Medium (`claude-opus-5[effort=medium]`)  | No        | Quality, security, whether the change makes sense                             |

Custom subagents live in `.cursor/agents/`. Skills live in `.cursor/skills/`. Launch the named subagent — do not impersonate a role with `generalPurpose`.

## When to use this team

Use `/ship-feature` (skill `.cursor/skills/ship-feature`) for any feature, bug with cross-layer impact, new MCP tool, widget, or schema change.

Tiny one-file fixes may skip the architect, but they still need the reviewer and a PR. Nothing ships as "done" on a builder's say-so.

## Feature workflow

The parent agent is the orchestrator. It does not implement the feature itself when specialists apply.

1. **Plan** — Launch `architect`. It reads `CLAUDE.md`, explores the tree, and returns a plan with exclusive file ownership per specialist. No code in this step.
2. **Distribute** — Launch only the specialists the plan named. Give each the plan excerpt, their file list, and the files they must not touch. One writer per file. If `src/mcp.ts` is in play, exactly one specialist owns it (usually backend).
3. **Sequence** — Schema first when the database specialist is involved. Then backend and frontend in parallel if their files do not overlap. Shared files stay serial.
4. **Prove** — After builders return, run `bun run format:check`, `bun run typecheck`, and `bun test` (or the files the plan named). Fix format/type/test failures by sending the owning specialist back in; do not patch across ownership lines.
5. **Review** — Launch `reviewer` (read-only) with the plan, the diff, and the test output. The reviewer checks code quality, security, and whether the change makes sense.
6. **Loop** — `REQUEST CHANGES` goes back to the owning specialist, then the reviewer runs again on the new diff. Repeat until `APPROVE`.
7. **PR** — The feature is finished only when the reviewer returns `APPROVE` with zero blocking findings. The orchestrator then commits on a feature branch, pushes, and opens a pull request. Return the PR URL. Do not merge — merging `main` deploys production.

## Hard rules

- **Reviewer is the gate.** Builders must not mark the feature done. A reviewer that finds nothing is suspect — they must list what they inspected.
- **Builders do not verify their own work** as the final check. They may run tests locally; the reviewer still runs.
- **Builders do not git commit, push, or change git config.** After `APPROVE`, the orchestrator commits, pushes the feature branch, and opens a PR. Do not merge.
- **One writer per file** in a wave. Name the files another specialist currently holds.
- **Do not bump the server version** unless the user asked to publish to the MCP Registry. Deploy is merge-to-main, not a version tag.
- **Read `CLAUDE.md` before touching import, export, timestamps, widgets, or dual-backend data paths.** Those sections are landmines, not background.

## Skills

| Skill          | Use                                                |
| -------------- | -------------------------------------------------- |
| `ship-feature` | End-to-end autonomous feature ending in a PR. Default entry. |
| `architect`    | Plan-only playbook the architect subagent follows. |
| `database`     | Dual-backend schema/migration playbook.            |
| `backend`      | MCP tool / Bun server playbook.                    |
| `frontend`     | MCP Apps widget playbook.                          |
| `review`       | Reviewer checklist and verdict format.             |

Each specialist subagent reads its skill before working. The orchestrator reads `ship-feature`.
