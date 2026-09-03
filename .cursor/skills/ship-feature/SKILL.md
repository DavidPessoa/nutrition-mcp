---
name: ship-feature
description: Run a nutrition-mcp feature from plan through implementation, review, and a pull request. Use when the user asks to build, ship, implement, or finish a feature, MCP tool, widget, schema change, or cross-layer bug. Orchestrates architect, database, backend, frontend, and reviewer subagents. Feature is done only when the reviewer approves and a PR exists.
---

# Ship a feature

You are the orchestrator, not the implementer. Launch the named subagents in `.cursor/agents/`. Do not impersonate them with `generalPurpose`.

Read `AGENTS.md` and `CLAUDE.md` first.

## 1. Plan

Launch `architect` with:

- The user request, verbatim
- Any constraints they named (scope, files, "don't touch X")
- Instruction to return the plan template from `.cursor/skills/architect/SKILL.md`

Wait for the plan. If it is vague, missing file ownership, or assigns the same writable file to two specialists, send it back to `architect` before anyone codes.

Show the user the plan only if they asked to see it or the change is unusually large. Otherwise proceed.

## 2. Distribute

Launch each named specialist with a self-contained prompt (they have no chat history):

- The relevant plan section
- Exclusive file list they may write
- Files they must not touch
- Acceptance criteria
- "Read your skill under `.cursor/skills/<role>/SKILL.md` and `CLAUDE.md`"
- "Do not git commit"

Sequence:

- Database first if a migration or `schema/postgres.sql` change is in the plan
- Then backend and frontend in parallel when their files do not overlap
- `src/mcp.ts` has one owner, named in the plan

Cap concurrent implementation subagents at 3.

## 3. Prove

After builders return:

```bash
bun run format:check
bun run typecheck
bun test
```

If the plan named a tighter test glob and the full suite is long, run that glob plus `format:check` and `typecheck`. Before calling the reviewer, still prefer a full `bun test` when the change can leak.

Send failures back to the owning specialist with the error output. Do not fix across ownership lines.

## 4. Review

Launch `reviewer` (read-only) with:

- The original request and the plan
- `git diff` against the starting point (or the file list + what changed)
- Test/format/typecheck output
- Builder reports
- Instruction to follow `.cursor/skills/review/SKILL.md`

## 5. Loop until APPROVE

On `REQUEST CHANGES`:

1. Group blocking findings by owner
2. Re-launch those specialists with the finding list and the current diff
3. Re-run the prove step
4. Re-launch `reviewer` on the new diff

Non-blocking suggestions are optional. Do not treat them as a veto unless the reviewer marked them blocking.

Stop only when the verdict is `APPROVE` and blocking findings are zero.

## 6. Pull request

Every feature ends with a PR. Do this only after `APPROVE`. Specialists still must not git.

Work on a feature branch, not `main`. If HEAD is `main`, create and switch to a branch named for the feature (`feat/…`, `fix/…`) before committing.

Commit as the orchestrator:

1. In parallel: `git status`, `git diff`, `git log -8 --oneline` (match the repo's message style).
2. Stage only product files from this feature. Do not add `.env`, credentials, or unrelated dirt.
3. Commit with a 1–2 sentence message that explains why, via HEREDOC:

```bash
git commit -m "$(cat <<'EOF'
<message>

EOF
)"
```

4. Push and open the PR with `gh` (never the GitHub website by hand):

```bash
git push -u origin HEAD
gh pr create --title "<title>" --body "$(cat <<'EOF'
## Summary
- <what changed and why>

## Test plan
- [ ] `bun run format:check`
- [ ] `bun run typecheck`
- [ ] `bun test` (or the files this feature covers)
- [ ] <behavior to click/verify if UI>

EOF
)"
```

If the branch already tracks a remote, push then `gh pr create` (or reuse the open PR if this wave updated it). Never `--force` to `main`. Never merge. Never `git commit -i` / `git add -i`. Do not skip hooks. Do not bump the server version unless they asked to publish to the registry.

## 7. Finish

Report to the user:

- What landed (files, behavior)
- Reviewer verdict (quote the one-line summary)
- Tests run
- PR URL
- Anything the reviewer flagged as follow-up

## Failures

- A specialist edits a file they do not own: stop that wave, revert or re-assign, continue.
- Architect wants to implement: refuse and take only the plan.
- Reviewer wants to patch: refuse; send findings to builders.
- Reviewer returns APPROVE without listing what they inspected: send them back.
