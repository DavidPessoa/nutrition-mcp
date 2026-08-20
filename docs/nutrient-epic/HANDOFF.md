# Nutrient Accuracy & Micronutrient Expansion — Handoff

**Branch:** `claude/nutrient-accuracy-d3e306` (git worktree)
**Updated:** 2026-08-19
**Status:** All eight builder tracks BUILT. Independent verification ran once and
returned **FAIL** with three findings; two are fixed, one is open. The epic is
NOT done. See "Where it actually stands".

**Working tree is CLEAN.** Everything is committed; nothing is half-finished.

Read `docs/nutrient-epic/CONTRACT.md` FIRST — names, units, provenance shape,
source precedence, file ownership, landmines. Do not re-derive any of it.
`FEATURE_REQUEST.md` (same directory) holds the per-agent acceptance criteria,
the six E2E scenarios and the Definition of Done that CONTRACT deliberately
does not duplicate.

---

## START HERE

### 1. Environment

`bun` is **not installed on this machine** and is not on PATH. Every session
must do this first or every command fails:

```bash
export PATH="/private/tmp/claude-501/-Users-davidparreira-Documents-Git-Personal-nutrition-mcp--claude-worktrees-nutrient-accuracy-d3e306/9081a337-d677-4dfe-9499-a8e59d6191ce/scratchpad/node_modules/.bin:$PATH"
bun --version   # expect 1.3.14
```

If that scratchpad is gone, reinstall it somewhere outside the repo:
`npm i bun --prefix /tmp/bun-host` then PATH `/tmp/bun-host/node_modules/.bin`.
Do not install bun into the repo and do not add it to package.json.

`.env` exists, is gitignored, and holds a real `USDA_FDC_API_KEY` and
`OFF_USER_AGENT`. Bun auto-loads it. **Never print the key or commit it.**
There is **no** `SUPABASE_URL` / `SUPABASE_SECRET_KEY`, which is why every
database-dependent gate below is unmet.

Confirm the baseline before changing anything:

```bash
bun run format:check && bun run typecheck && bun test
```

Expect clean, clean, **1013 pass** (30 files). Baseline before this epic was
698 tests.

### 2. Orchestration model that has been working

You are the orchestrator. Delegate to subagents; you own git. Rules that
earned their place:

- **One writer per file.** Give each agent an explicit file list and name the
  files another agent currently holds. Two agents on `src/mcp.ts` (4,700
  lines) is how a silent merge mistake happens.
- **Subagents must not run git.** They leave changes in the working tree; you
  inspect, run the gate, and commit selectively with `git add <paths>`.
- **Builders do not verify their own work.** Every real bug in this epic was
  found by an agent auditing someone else's code, and every one of them had
  passed the builder's own suite first.
- **A verifier that finds nothing is suspect.** Tell agents to report defects
  rather than silently patch them, and to state what they tried when they
  find nothing.
- Agents have been cut off mid-run by session limits. Their partial work was
  coherent and salvageable both times — inspect the tree and run the gate
  before assuming anything is lost.

---

## Where it actually stands

### Commits on this branch (newest first)

```
a161298  fix(import): the widget was dropping every micronutrient it could already read
2f592fc  docs(nutrient-epic): hand over with the verification failure stated plainly
c721a15  fix(summaries): scale a micronutrient target to the range it is judged over
cdfca38  fix(validation): stop the validators editing the evidence they validate
9a2fb4a  feat(summaries): fold per-nutrient confidence into the coverage payload
713fd79  feat(widgets): show micronutrients without letting a partial total look whole
636f295  fix(import): an empty cell was becoming a real zero, and micros never arrived
cad6774  fix(export): goals.csv was silently dropping every micronutrient goal
b729637  fix(insights): a zero floor is not a target, and coverage counts calories
69de2fd  feat(nutrients): coverage-aware summaries, micronutrient goals, import/export
0ddc9df  feat(usda): read Atwater energy when a Foundation record has no 208
bc3d350  fix(usda): validate against live FoodData Central, and stop losing to parens
fb4f7c1  fix(nutrients): make the resolution result the only authority on a write
b7ced28  feat(nutrients): source precedence and the expanded model through MCP
e273f8e  feat(usda): FoodData Central provider for generic whole foods
7e3fd30  test(off): cover the micronutrient mapping with fixtures and live validation
06b8052  feat(nutrients): canonical nutrient model, provenance and unit normalization
```

### Builder tracks

| #   | Track              | State                                                                      |
| --- | ------------------ | -------------------------------------------------------------------------- |
| 1   | schema + storage   | BUILT, verifier PASS                                                       |
| 2   | units / conversion | BUILT, verifier PASS                                                       |
| 3   | Open Food Facts    | BUILT, live-validated, verifier PASS (re-validated independently)          |
| 4   | USDA FDC           | BUILT, live-validated, verifier PASS                                       |
| 5   | resolution + MCP   | BUILT, PASS on log_meal/update_meal — **but see Finding 3**                |
| 6   | summaries + goals  | BUILT; verifier FAIL (Finding 1) → **fixed** in c721a15                    |
| 7   | import / export    | BUILT; verifier FAIL (Finding 2) → **fixed** in a161298                    |
| 8   | widgets            | BUILT; rendered Finding 1's false verdict → **fixed** in c721a15           |
| 9   | verification       | Ran once, returned FAIL. **Must run again** after the open findings close. |

---

## OPEN — what the next orchestrator must do

### 1. Finding 3 (MEDIUM-HIGH, NOT STARTED) — `bulk_import_meals` bypasses the resolution policy

`src/import.ts` never calls `resolveNutrientWrite` / `isForbiddenEstimate`.
Two consequences, both verified by running `validateRow` directly:

- an **estimated micronutrient can be stored** through this path — exactly
  what `log_meal` and `update_meal` refuse (CONTRACT §0.2);
- the caller **chooses its own provenance**, so a model-invented value can
  land at precedence 1 (`nutrition_label`, `authoritative`), outranking USDA
  and a real user correction, and get a "measured" badge in the widget.

`bulk_import_meals` is deliberately model-visible (`_meta.ui.visibility`
includes `"model"` — CLAUDE.md explains why), so a model can call it directly
with invented rows.

This is a genuine design tension, not just an oversight: an import is the
user's own history, and trusting the file is what makes the export/re-import
round trip lossless. Decide deliberately. The minimum the verifier asked for:
refuse a provenance entry whose `source` is `model_estimate` on a
micronutrient, and tighten the tool description so the model stops treating
it as a general-purpose writer. Owns `src/import.ts` and the tool description
in `src/mcp.ts`.

### 2. Re-run independent verification

Findings 1, 2, 4 and 5 are fixed, but **no verifier has seen any of those
fixes** — they were written by the same builders whose work failed. Re-run a
full adversarial pass once Finding 3 closes. Attack the range-scaling shape
(`target_days`) and the widget's new browser-side CSV mapper hardest; both
are new logic written under time pressure at the end of a session. Brief it with the three bugs already found in this epic as
calibration — they are listed in "Bugs this epic actually found" below.

### 3. Small, known, unfixed

- `public/widgets/STYLE_GUIDE.md` (~line 763) documents the
  `NUTRIENT_COVERAGE_ITEM` row shape and never mentions `target_days`.
- The import widget's height re-report after its now-wider preview table was
  NOT verified in a real host iframe — `bun run harness`'s sandboxed iframe is
  blocked by a browser client policy in this environment. The sizing path
  itself is unchanged (bridge.js's ResizeObserver), but it is unproven.
- The import preview table is ~1850px wide with full nutrient names. It
  scrolls inside the existing `.tscroll`; abbreviations would be kinder.
- `resolveNutrientWrite` treats `{field: undefined}` as an explicit clear.
  No live path reaches it (`suppliedNutrients` filters `undefined` first) but
  it is one refactor away from wiping stored values.
- `scripts/validate-usda.ts` reads its "per 100 g (source)" column from the
  app's own `normalizeFdcFood` output, so it validates the scaling arithmetic
  only — the nutrient-number → field → unit mapping is compared against
  itself. The verifier closed that gap by hand for three foods (see
  `validation/usda/README.md`); the script is still weak.
- OFF nutrient 539 (added sugars) has never appeared in a real payload;
  `added_sugar_g` from USDA is mapped from the INFOODS tagname only.

---

## BLOCKED — needs a database, and nothing else will unblock it

**All six E2E release scenarios, the clean-database migration test, and Agent
1's real round-trip gate are formally UNMET**, and no amount of code work
changes that. Every one of them writes a meal and reads it back.

Two migrations have **never been applied to any database**:

```
supabase/migrations/20260819120000_micronutrient_expansion.sql   (12 columns + nutrient_provenance jsonb)
supabase/migrations/20260819130000_micronutrient_goals.sql       (10 min_/max_ goal columns)
```

To unblock, put a **test** Supabase project (never production) in `.env`:

```
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SECRET_KEY=<service key>
```

apply both migrations, then work through `validation/e2e/README.md`, which
already lists the six scenarios and the evidence format. Do not record any of
them as passed on the strength of unit tests — they exist precisely because
unit tests cannot see a `numeric` column's precision or a jsonb round trip.

What IS proven without a database, and re-verified independently today:

```bash
bun run validate:off     # 3 real barcodes, live, every value hand-derived
bun run validate:usda    # 5 real FDC records, live, scaling checked outside the scaler
```

Both pass. `validate:usda --capture` refreshes fixtures; without the flag it
leaves them alone (it used to rewrite the evidence it was validating).

---

## Bugs this epic actually found — use these to calibrate a verifier

Each passed the builder's own test suite first. This is the calibre of defect
to hunt for:

1. **The resolution policy was decorative.** The write was built as
   `{ ...args, ...resolved }`, so a REFUSED value was merely absent from the
   overlay and the caller's original survived underneath it. A meal stored an
   estimated 900 mg sodium and rendered "Sodium: 900 mg" five lines above
   "(Not stored: sodium_mg)". On update it stored a rejected number while the
   provenance still said `open_food_facts / authoritative` — a model-invented
   figure labelled authoritative, which is worse than either half alone.
2. **`z.coerce.number().parse("")` is `0`.** `Number("")` is 0 and Zod coerces
   before validating, so a blank CSV cell became a confident zero — on fields
   that had shipped months earlier.
3. **A stored goal of `0` on a MINIMUM** leaked into structuredContent as a
   real target the text output denied existed, and every progress ratio
   divides by it.
4. **A range total judged against a daily target** (Finding 1): three ordinary
   days read as "over limit"; on a floor, a third of the target read as "met".
5. **The import widget dropped every micronutrient** (Finding 2) while
   `src/csv.ts` had a complete tested resolver inlined into that very widget,
   referenced only from a test file.

The pattern worth internalising: **the response text was reassuring while the
row was wrong.** Assert on what reached storage, not on what the tool said.

---

## LANDMINES (unchanged, still true)

1. **The frozen idempotency digest.** `mealIdempotencyKey` (`src/supabase.ts`)
   and `rowContentDigest` (`src/import.ts`) hash a POSITIONAL, deliberately
   INCOMPLETE field array. **Never add a nutrient field to either.** Both
   carry warning comments and regression tests.
2. **`null` != `0`, everywhere.** Assert null-ness separately from numeric
   tolerance — "within 0.1 of zero" must never pass for an unrecorded
   nutrient.
3. **Widening a shared type breaks distant fixtures.** Patch the shared
   factory, not each call site, and let `bun run typecheck` adjudicate.
4. **Cache backfill.** A newly added field must be explicitly backfilled to
   `null` in `getCachedFood`, or cached rows deserialize `undefined` and fail
   `.nullable()` structuredContent validation.
5. **Vitamin A/D in IU cannot be converted** to µg RAE / µg. Sources
   reporting IU must leave the field null. Both OFF and USDA carry IU entries
   beside the µg ones — this is real, not theoretical.
6. **USDA energy** appears as 208 (kcal), 268 (kJ) and 957/958 (Atwater
   kcal). Order is 208 → 957 → 958, and the unit is checked on every
   candidate. 4 of 5 validated records carry the kJ entry too.
7. **api.data.gov intermittently 400s any URL containing a parenthesis** —
   `%28` fails as often as a literal `(`. USDA search therefore uses POST
   with a JSON body. A test asserts no parenthesis reaches the URL.
8. **`.nullable()` in Zod = REQUIRED** with `anyOf[type,null]`. A missing key
   makes a widget render nothing, silently.
9. **Widgets must re-report height** via `ui/notifications/size-changed` after
   every re-render, including a toggle, or the host clips them.
