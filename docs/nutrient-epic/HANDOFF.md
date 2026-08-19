# Nutrient Accuracy & Micronutrient Expansion — Handoff

**Branch:** `claude/nutrient-accuracy-feature-985289` (git worktree)
**Date:** 2026-08-19
**Status:** Wave 1 complete, Wave 2 partial. Tree is GREEN and safe to continue from.

Read `docs/nutrient-epic/CONTRACT.md` FIRST. It is the canonical cross-agent
contract — nutrient names, units, provenance shape, source precedence, file
ownership, and the landmines. Do not re-derive any of it.

---

## START HERE (next session)

### 1. Environment

`bun` is NOT on the default PATH. Every session must run this first, or every
command in this document fails with "bun: command not found":

```bash
export PATH="$HOME/.bun/bin:$PATH"
```

Working directory is the worktree, not the main checkout:

```
/Users/davidparreira/Documents/Git/nutrition-mcp/.claude/worktrees/nutrient-accuracy-feature-985289
```

Confirm the baseline before changing anything:

```bash
bun run format:check && bun run typecheck && bun test
```

Expect: clean, clean, 841 pass. If that is not what you see, something drifted —
diagnose before building on top of it.

### 2. The three documents in this directory

| File                 | What it is                        | When to read                                                                                                                                                                           |
| -------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FEATURE_REQUEST.md` | The original epic spec, verbatim  | Before Agents 5–9. It holds the per-agent acceptance criteria, the six E2E release scenarios, and the Definition of Done checklist that `CONTRACT.md` deliberately does not duplicate. |
| `CONTRACT.md`        | The binding cross-agent decisions | ALWAYS, first. Names, units, provenance shape, precedence, file ownership, landmines.                                                                                                  |
| `HANDOFF.md`         | This file — current state         | ALWAYS, second.                                                                                                                                                                        |

`CONTRACT.md` is a distillation, not a replacement. It settles the questions
builders kept re-deriving; it does not contain the E2E scenarios, the goal
field list, the CSV header aliases, or the UI hierarchy. Agents 6, 7 and 8 in
particular need `FEATURE_REQUEST.md`.

### 3. Immediate next actions, in order

1. **Finish Agent 3 before trusting any OFF data.** `src/foods.ts` is written
   but has ZERO test coverage for its new mapping. Add `src/fixtures/off/`,
   the tests, `scripts/validate-off.ts` + the `validate:off` script, and
   `validation/open-food-facts/README.md`. Verify the sodium g -> mg path and
   every OFF key spelling — none of it has been independently checked.
2. **Agent 4 (USDA) from scratch.** No files exist. See `CONTRACT.md` §5 for
   ownership and `FEATURE_REQUEST.md` "Agent 4" for acceptance criteria.
3. **Agent 5 (resolution + MCP).** The largest job — `src/mcp.ts` is 216 KB.
   Use a strong model. It must implement the `SOURCE_PRECEDENCE` comparison
   logic Agent 1 deliberately left out.
4. Then Agents 6 and 7 (parallel), 8, and finally 9.

---

## Tree state (verified, not assumed)

```
bun run format:check   PASS
bun run typecheck      PASS  (src/ typechecks clean)
bun test               PASS  841 / 841, 28 files
```

Baseline before this epic was 698 tests. Net +143, all from Agent 1.

**IMPORTANT: none of this is committed.** Everything is uncommitted working-tree
changes in the worktree. Commit before doing anything risky.

---

## Orchestration model

The feature request specifies 10 agents. Agent 0 (orchestrator) pins the
contract and integrates; Agents 1–8 build; Agent 9 independently verifies.
Dependency order:

```
1 schema ─┬─ 2 provider core ─┬─ 3 OFF ──┬─ 5 resolution+MCP ─┬─ 6 summaries ─┬─ 8 UI ─ 9 verify
          │                   └─ 4 USDA ─┘                     └─ 7 import/exp ┘
```

Agents 1 and 2 were run in parallel by splitting what the spec called one module
into two (`src/nutrients.ts` = model, `src/nutrient-units.ts` = conversion), so
they never raced the same file. Keep that split.

---

## DONE

### Agent 1 — schema and storage (COMPLETE, tests included)

- `supabase/migrations/20260819120000_micronutrient_expansion.sql` — 12 nullable
  `numeric` columns + `nutrient_provenance jsonb`, each `check (col >= 0)`.
  **Not yet applied to any database.**
- `src/nutrients.ts` (284 lines) — `NUTRIENT_FIELDS`, `MICRONUTRIENT_FIELDS`,
  `ESTIMABLE_FIELDS`, `NUTRIENT_UNITS`, provenance types,
  `parseNutrientProvenance`, `SOURCE_PRECEDENCE`, `isValidNutrientValue`,
  `assertValidNutrientValue`.
- `src/nutrients.test.ts` (478 lines, 44 tests).
- `src/supabase.ts` — `Meal`/`MealInput` extended; new `normalizeMeal()` applied
  at every read/write return point; validation before DB writes.
- `src/supabase.test.ts` — +99 tests: full 7-case matrix (undefined/null/0/
  positive/negative/NaN/Infinity) x 12 fields, round trips, clear-to-null,
  provenance, and a frozen-digest regression test.

### Agent 2 — provider core and normalization (COMPLETE, tests included)

- `src/nutrient-units.ts` (323 lines) — THE only module permitted to contain
  unit/serving arithmetic. Mass ladder, `resolveServingValue` (the
  no-double-scaling guard), `scaleNutrients` (null-preserving).
- `src/nutrient-units.test.ts` (351 lines, 33 tests) incl. 5 hand-worked
  real-world vectors.
- `src/providers/types.ts` — `ServingBasis` discriminated union,
  `ProviderNutrientValues`, `FoodNutrition`, `NutritionProvider`.
- `src/providers/types.test.ts` (12 tests).

### Agent 0 — integration (me)

- `validation/README.md` — documented ABSOLUTE tolerances (not percentage —
  a percentage tolerance hides systematic unit/serving errors), credentials
  table, evidence-record format, directory layout.
- Fixed cross-cutting fixture breakage caused by the widened `Meal` and
  `FoodResult` types in `export.test.ts`, `insights.test.ts`, `search.test.ts`,
  `mcp.test.ts`, `foods.test.ts`.

---

## PARTIAL — resume here

### Agent 3 — Open Food Facts (implementation ~complete, NO TESTS)

`src/foods.ts` has +422 lines and typechecks clean. It already has:

- all 12 micronutrients mapped, with per-nutrient OFF key + unit recorded in
  comments against verified doc URLs;
- the sodium g -> mg conversion, including a real bug it caught and documented:
  rounding to 1 decimal first would turn Nutella's `sodium_100g 0.0428 g` into
  `0.0` and then `0 mg`, destroying a real 42.8 mg value;
- provenance emission (`open_food_facts` / `authoritative` / `off:<barcode>`);
- the cache-backfill landmine handled via `BACKFILL_NULL_FIELDS`, including
  best-effort `servingBasis` reconstruction for pre-existing cached rows.

STILL MISSING:

- `src/fixtures/off/` fixtures (complete / partial / per-serving / per-100g /
  explicit zero / missing / bad value / bad serving basis)
- tests in `src/foods.test.ts` asserting null-vs-zero distinctly, plus an
  explicit test that grams-sodium becomes the right mg number
- `scripts/validate-off.ts` + `validate:off` package.json script
- `validation/open-food-facts/README.md`

VERIFY BEFORE TRUSTING: nobody has independently checked Agent 3's OFF key
spellings, unit assumptions, or the sodium conversion. It wrote no tests, so
none of its mapping is currently covered.

### Agent 4 — USDA FoodData Central (NOT STARTED)

Produced no files. It had verified the FDC API contract with live DEMO_KEY calls
and was about to write code when it hit the limit. Start fresh.
Owns: `src/usda.ts`, `src/usda.test.ts`, `src/fixtures/usda/`,
`scripts/validate-usda.ts`, `USDA_FDC_API_KEY` in `.env.example`,
`validation/usda/`.

---

## NOT STARTED

- **Agent 5** — resolution policy + MCP read/write. Owns `src/resolution.ts`
  (new), `src/mcp.ts`, `src/mcp.test.ts`. Must implement the
  `SOURCE_PRECEDENCE` comparison logic that Agent 1 deliberately left out.
  This is the largest and hairiest job (`mcp.ts` is 216 KB) — use a strong model.
- **Agent 6** — coverage-aware summaries + micronutrient goals. Owns
  `src/insights.ts`. EXTEND the existing `PartialNutrient` / `dayCarries` /
  `coveredSeries` primitives; do not build a parallel system. Goals need a
  second migration for the `min_*`/`max_*` goal columns.
- **Agent 7** — import/export. Owns `src/import.ts`, `src/export.ts`,
  `src/csv.ts`. Note `meals.csv` must stay byte-compatible with the importer's
  column aliases.
- **Agent 8** — widgets. Owns `public/widgets/src/**`. Must visually distinguish
  0 / not recorded / partial / complete / estimated / authoritative.
- **Agent 9** — independent adversarial verification of everything.

---

## LANDMINES (each already caused or nearly caused a real bug)

1. **The frozen idempotency digest.** `mealIdempotencyKey` (`src/supabase.ts`)
   and `rowContentDigest` (`src/import.ts`) hash a POSITIONAL, deliberately
   INCOMPLETE field array. **Never add a nutrient field to either.** Doing so
   changes the derived key of every future write and orphans every stored
   `auto:` key. Agent 1 respected this and there is now a regression test
   locking it.
2. **`null` != `0`, everywhere.** Missing must never become zero at any layer.
   Assert null-stays-null SEPARATELY from numeric tolerance — "within 0.1 of
   zero" must never pass for an unrecorded nutrient.
3. **Widening a shared type breaks distant fixtures.** Both `Meal` and
   `FoodResult` did this. Patch the shared factory, not each call site — and let
   `bun run typecheck` adjudicate, because a pattern match will also hit
   expected-CSV-row literals that only look like the type.
4. **Cache backfill.** Any newly added field must be explicitly backfilled to
   `null` in `getCachedFood`, or cached rows deserialize `undefined` and fail
   `.nullable()` structuredContent validation.
5. **Vitamin A IU cannot be converted to µg RAE** (retinol vs β-carotene differ
   ~12x). Agent 2 deliberately did not implement it. A source reporting IU must
   leave `vitamin_a_mcg` null.
6. **USDA energy appears as both kcal and kJ** under different nutrient numbers.
   Never mistake one for the other.

---

## Open decisions for the next session

1. **`assertValidNutrientValue` scope.** Agent 1 wired it for the 12 new fields
    - `caffeine_mg` only, NOT for calories/protein/carbs/fat/fiber/sugar/alcohol,
      which are Zod-guarded at the `mcp.ts` boundary but unguarded if `supabase.ts`
      is called directly (e.g. from `import.ts`). Decide whether to close that gap.
2. **`updateMeal.nutrient_provenance` is full-replace, not per-key merge.**
   Consistent with every other field, documented and tested. Confirm that is
   what Agent 5 wants before building resolution on top of it.
3. **Nothing is committed.** Recommend committing the green state before Wave 3.
4. **No live validation has run.** No `.env`, no `SUPABASE_URL`,
   no `USDA_FDC_API_KEY`, no `OFF_USER_AGENT`. The migration has never been
   applied to a real database. Every "real-source validation" and E2E gate in
   the feature request remains formally unmet.
5. `bun` is not on the default PATH — `export PATH="$HOME/.bun/bin:$PATH"`.
   `bun.lock` has a benign 3-line change (dependency-range mirror resyncing to
   the already-committed `package.json`; no resolved version changed).
