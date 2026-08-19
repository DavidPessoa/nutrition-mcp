# Nutrient Accuracy Epic — Canonical Cross-Agent Contract (Agent 0)

READ THIS FIRST. It is the single source of truth for names, units, types and
file ownership. Do not re-derive any of it. Do not rename anything here.

Repo: nutrition-mcp (Bun + TypeScript). Working dir is a git worktree on branch
`claude/nutrient-accuracy-feature-985289`. Read `CLAUDE.md` for repo conventions
(Bun-only APIs, 4-space Prettier, `bun test`).

## 0. NON-NEGOTIABLE INVARIANTS

1. `null` = unknown/not recorded. `0` = source explicitly reports zero. NEVER
   collapse missing into zero, at any layer (DB, TS, CSV, widget, summary).
2. Never auto-estimate a MICRONUTRIENT. Only these six may be model-estimated:
   calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g.
3. Estimated values must be marked `source=model_estimate`, `confidence=estimated`.
4. A lower-precedence source must never automatically overwrite a
   higher-precedence one (see §4).
5. Unit conversion happens in EXACTLY ONE module (`src/nutrient-units.ts`). Do not
   put conversion arithmetic in tool handlers, widgets, importers or providers.
6. Serving scaling happens exactly once. Never double-scale.
7. Backward compatibility: existing meals must stay valid and expose new fields
   as `null`.
8. No live external API calls in `bun test`. Fixtures only.
9. Ambiguous unit or serving basis => return `null`. Never guess.

## 1. CANONICAL NUTRIENT MODEL

Existing (already shipped, DO NOT change):
calories (kcal, integer column), protein_g, carbs_g, fat_g, fiber_g, sugar_g,
alcohol_g (all g, numeric), caffeine_mg (mg, numeric)

NEW — exactly these twelve, exactly these names, no additions:
saturated_fat_g g
trans_fat_g g
added_sugar_g g
sodium_mg mg
potassium_mg mg
cholesterol_mg mg
calcium_mg mg
iron_mg mg
magnesium_mg mg
vitamin_a_mcg µg RAE
vitamin_c_mg mg
vitamin_d_mcg µg

`sugar_g` stays TOTAL sugars. `added_sugar_g` is separate and is NOT derived
from it.

DB: all twelve are `numeric` (NOT integer), nullable, no default, with
`check (<col> >= 0)`. Mirrors the caffeine_mg migration exactly.

## 2. PROVENANCE

Column: `meals.nutrient_provenance jsonb` (nullable).

Shape — an object keyed by canonical nutrient field name:

```json
{
    "sodium_mg": {
        "source": "usda_fdc",
        "source_id": "fdc:123456",
        "confidence": "authoritative"
    }
}
```

`source_id` is optional/nullable. Per-nutrient only — NEVER one global
confidence flag on the meal.

SOURCES (exact strings):
nutrition_label | open_food_facts | usda_fdc | restaurant_published
| user_provided | import | model_estimate

CONFIDENCE (exact strings):
authoritative | user_provided | estimated

## 3. TYPESCRIPT CONTRACT

TWO new modules, with a strict split so no two agents write the same file:

### `src/nutrients.ts` — THE NUTRIENT MODEL (Agent 1 owns, creates)

- `NUTRIENT_FIELDS` — readonly array of every canonical nutrient field name
  (existing 8 + new 12), the single list every layer iterates.
- `MICRONUTRIENT_FIELDS` — the 12 new ones.
- `ESTIMABLE_FIELDS` — calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g.
- `NutrientField` — union type of the field names.
- `NutrientUnit` / `NUTRIENT_UNITS: Record<NutrientField, "kcal"|"g"|"mg"|"mcg">`
- `NutrientSource`, `NutrientConfidence`, `NutrientProvenanceEntry`,
  `NutrientProvenance = Partial<Record<NutrientField, NutrientProvenanceEntry>>`
- `parseNutrientProvenance(raw: unknown): NutrientProvenance | null` — defensive,
  drops unknown keys/invalid entries rather than throwing.

### `src/nutrient-units.ts` — ALL CONVERSION (Agent 2 owns, creates)

The single module permitted to contain unit/serving arithmetic. It IMPORTS
types from `src/nutrients.ts` and must not redefine them.

Do NOT hardcode nutrient key lists anywhere else. Derive from `NUTRIENT_FIELDS`.
Do NOT put conversion arithmetic anywhere but `src/nutrient-units.ts`.

## 4. SOURCE PRECEDENCE (lower number wins)

1 nutrition_label (confidence: authoritative)
2 open_food_facts (authoritative) — exact barcode/product
3 restaurant_published (authoritative)
4 usda_fdc (authoritative)
5 user_provided (user_provided)
5 import (user_provided) — same tier; user's own data
6 model_estimate (estimated)

Rule: a write may only replace an existing nutrient value when its precedence
number is <= the stored one, OR the user explicitly overrides. Explicit user
override and explicit clear-to-null are always allowed.

## 5. FILE OWNERSHIP (do not edit files another agent owns)

Agent 1 supabase/migrations/<new>.sql, src/nutrients.ts, src/nutrients.test.ts,
src/supabase.ts, src/supabase.test.ts
Agent 2 src/nutrient-units.ts, src/nutrient-units.test.ts,
src/providers/types.ts, src/providers/ (new dir), their tests
(Agent 2 may READ src/nutrients.ts but must NOT edit it.)
Agent 3 src/foods.ts, src/foods.test.ts, fixtures under src/fixtures/off/
Agent 4 src/usda.ts (new), src/usda.test.ts, src/fixtures/usda/, .env.example
Agent 5 src/mcp.ts, src/mcp.test.ts, src/resolution.ts (new) + test
Agent 6 src/insights.ts, src/insights.test.ts, goals in src/supabase.ts*
Agent 7 src/import.ts, src/export.ts, src/csv.ts + their tests
Agent 8 public/widgets/src/**, src/widgets.test.ts
(*Agent 6 coordinates with Agent 0 before touching src/supabase.ts.)

## 6. LANDMINE — THE FROZEN IDEMPOTENCY DIGEST

`mealIdempotencyKey` in src/supabase.ts and `rowContentDigest` in src/import.ts
hash a POSITIONAL, DELIBERATELY INCOMPLETE field array.

*** DO NOT ADD ANY NEW NUTRIENT FIELD TO EITHER ARRAY. ***

Adding one changes the derived key of every future write, orphans every stored
`auto:` key, and reintroduces a bug this repo has already shipped once. Both
arrays carry an explicit warning comment. Leave them exactly as they are.

## 7. EXISTING PATTERNS TO EXTEND, NOT REINVENT

- `PartialNutrient`, `dayCarries`, `coveredSeries`, `coveredDailyAverage` in
  src/insights.ts already implement "a day carries a nutrient when >=1 meal has
  a non-null value". Agent 6 EXTENDS `PartialNutrient` to the new micros and
  builds coverage metrics on this, rather than writing a parallel system.
- `alcohol_tracking_enabled` shows the opt-in display-gating pattern. The new
  micros need NO opt-in flag — behave like fiber/sugar/caffeine (data-driven
  display: show a nutrient only once the user actually has it recorded).
- Cache backfill: `getCachedFood` in src/foods.ts explicitly backfills new keys
  to `null` for rows cached before the field existed. Any new nutrient MUST get
  the same treatment or `.nullable()` structuredContent validation fails.
- `.nullable()` in Zod = REQUIRED with `anyOf[type,null]`. Every result literal
  must set explicit `null`s, never omit the key.

## 8. QUALITY GATE (every agent, before reporting done)

```
bun run format
bun run format:check
bun run typecheck
bun test
```

All must pass. `typecheck` only covers `src/`, so type errors in test files
will NOT be caught — be careful there.

Add regression tests for every changed behavior. For each new nutrient field
cover: undefined -> null, null -> null, 0 -> 0, positive -> preserved,
negative -> rejected, NaN -> rejected, Infinity -> rejected.

## 9. HANDOFF FORMAT (report back to Agent 0)

- design implemented
- files changed (paths)
- migrations added
- tests added + `bun test` result (counts)
- known limitations
- anything the independent verifier must look at

You are NOT allowed to declare your own work DONE. Status on completion is
BUILT/VALIDATED. Agent 0 and the independent verifier decide DONE.
