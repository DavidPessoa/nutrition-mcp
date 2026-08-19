# Nutrient Accuracy & Micronutrient Expansion — Handoff

**Branch:** `claude/nutrient-accuracy-d3e306` (git worktree; fast-forwarded
from `claude/nutrient-accuracy-feature-985289`, which holds the same history)
**Date:** 2026-08-19
**Status:** Wave 1 and Wave 2 complete. Tree is GREEN, and everything is now
COMMITTED. Next up: Agent 5 (resolution + MCP).

Read `docs/nutrient-epic/CONTRACT.md` FIRST. It is the canonical cross-agent
contract — nutrient names, units, provenance shape, source precedence, file
ownership, and the landmines. Do not re-derive any of it.

---

## START HERE (next session)

### 1. Environment

`bun` may not be installed at all on the machine you land on — the earlier
sessions ran elsewhere. Check first:

```bash
bun --version || npm i bun --prefix /tmp/bun-host   # then PATH it
export PATH="$HOME/.bun/bin:/tmp/bun-host/node_modules/.bin:$PATH"
```

Installing into a scratch prefix keeps it out of the repo and off the user's
global toolchain.

Working directory is the worktree, not the main checkout:

```
/Users/davidparreira/Documents/Git/nutrition-mcp/.claude/worktrees/nutrient-accuracy-feature-985289
```

Confirm the baseline before changing anything:

```bash
bun run format:check && bun run typecheck && bun test
```

Expect: clean, clean, 870 pass. If that is not what you see, something drifted —
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

1. **Run `bun run validate:usda` as soon as a `USDA_FDC_API_KEY` exists.**
   This is the one outstanding gate on Agent 4. The script CAPTURES real FDC
   records over the synthetic fixtures in `src/fixtures/usda/` and compares
   scaled values against independent arithmetic; the expected numbers in
   `src/usda.test.ts` will need updating to match, and any mismatch there is
   a finding, not a chore. Free key:
   <https://fdc.nal.usda.gov/api-key-signup.html>.
2. **Agent 5 (resolution + MCP).** The largest job — `src/mcp.ts` is 216 KB.
   Use a strong model. It must implement the `SOURCE_PRECEDENCE` comparison
   logic Agent 1 deliberately left out, and wire both providers
   (`src/foods.ts`, `src/usda.ts`) behind it.
3. Then Agents 6 and 7 (parallel), 8, and finally 9.

---

## Tree state (verified, not assumed)

```
bun run format:check   PASS
bun run typecheck      PASS  (src/ typechecks clean)
bun test               PASS  870 / 870, 29 files
bun run validate:off   PASS  (live, 2026-08-19)
bun run validate:usda  NOT RUN — needs USDA_FDC_API_KEY
```

Baseline before this epic was 698 tests. Net +172.

Everything is committed:

```
06b8052  feat(nutrients): canonical nutrient model, provenance and unit normalization
01fec6d  docs(nutrient-epic): vendor the epic spec and add a START HERE guide
7e3fd30  test(off): cover the micronutrient mapping with fixtures and live validation
e273f8e  feat(usda): FoodData Central provider for generic whole foods
```

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

### Agent 3 — Open Food Facts (COMPLETE, live-validated)

- `src/foods.ts` maps all 12 micronutrients, reading each product's own
  `<key>_unit` rather than assuming grams, so an IU-reported vitamin A yields
  `null` instead of a wrong number.
- `src/fixtures/off/` — three REAL captured API responses (Nutella, Cheerios,
  Chocapic) plus five synthetic edge fixtures, each carrying a `_note`.
- `src/foods.test.ts` +11 tests: the sodium `0.0428 g -> 42.8 mg` false-zero
  lock, explicit source zeros surviving as `0`, ambiguous units -> `null`,
  per-serving vs per-100g basis, provenance, and the `toFoodNutrition`
  adapter.
- `scripts/validate-off.ts` + `validate:off`, `validation/open-food-facts/`.

Verified live before writing anything: the hyphenated key spellings, the
`<key>_unit` sibling convention, and that OFF stores every micronutrient in
GRAMS regardless of the field's canonical unit. `validate:off` passed clean
on 2026-08-19 across all three products.

Not covered live: vitamin C (no sampled product reported it) and vitamin A
in IU (ditto) — both are documented in `validation/open-food-facts/README.md`
and covered deterministically by fixtures.

### Agent 4 — USDA FoodData Central (BUILT, live validation OUTSTANDING)

- `src/usda.ts` — `searchFoods`, `getFood`/`lookupFood`, `normalizeFdcFood`,
  `readNutrients`, `resolveAmount`, `buildUsdaProvenance`. Cache stores the
  RAW payload so the mapping can improve without waiting out the TTL.
- `src/usda.test.ts` (18 tests), `src/fixtures/usda/` (5 fixtures),
  `scripts/validate-usda.ts` + `validate:usda`, `USDA_FDC_API_KEY` in
  `.env.example`, `validation/usda/README.md`.

Response shapes came from USDA's published OpenAPI v3 spec (both the nested
detail shape and the flat abridged search shape). Two deliberate refusals,
both tested: energy is read ONLY from nutrient 208 with `unitName` KCAL (268
is kJ — a 4x error that looks plausible), and vitamin A/D in IU (318, 324)
are dropped rather than converted.

**The fixtures are SYNTHETIC** — schema-shaped, placeholder numbers, each
saying so in its own `_note`. No live FDC response has ever been checked
against this mapping; DEMO_KEY was rate-limited and no key was available.
This is the epic's one knowingly-unmet gate. See action 1 above.

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
3. ~~Nothing is committed.~~ Resolved — all four commits are on the branch.
4. **Live validation is partially done.** `validate:off` has passed against
   real products. Still outstanding: `USDA_FDC_API_KEY` (Agent 4's gate),
   and `SUPABASE_URL` / `SUPABASE_SECRET_KEY` pointing at a TEST project —
   the migration `20260819120000_micronutrient_expansion.sql` has still never
   been applied to any database, so Agent 1's round-trip gate and every E2E
   scenario remain formally unmet.
5. Agent 4's `resolveAmount` is the only scaling entry point callers should
   use. If Agent 5 scales again on top of it, that is the double-scaling bug
   the contract forbids.
