# Feature Request: Nutrient Accuracy & Micronutrient Expansion

## Repository

`akutishevsky/nutrition-mcp`

## Feature name

**Nutrient Accuracy & Micronutrient Expansion**

## Objective

Extend Nutrition MCP from a macro-focused nutrition tracker into a trustworthy macro + micronutrient tracker that can replace the nutrition-tracking portion of MyFitnessPal for day-to-day use.

The implementation must prioritize **data correctness, source transparency, and completeness awareness** over filling every field.

The system should:

- accurately track calories and macros;
- add useful micronutrient tracking;
- use authoritative nutrition sources when available;
- preserve user-entered or imported values exactly;
- distinguish known zero from unknown;
- never silently fabricate micronutrients;
- record where nutrient values came from;
- expose meaningful completeness/coverage information in summaries;
- preserve nutrient data through import/export;
- validate every provider and calculation against real nutrition data before a feature is considered complete.

This deployment is expected to be **private, single-user, self-hosted, and reachable only behind a VPN**. Public-internet OAuth hardening is outside the scope of this feature.

---

# Product principles

## 1. Unknown is not zero

This is a hard invariant across the entire system.

```text
NULL = unknown / unavailable / not recorded
0    = explicitly known to be zero
```

Examples:

- Missing sodium from a food database must remain `null`.
- Blank CSV fields must remain `null`.
- A provider that omits iron must not produce `0 mg`.
- A product explicitly reporting `0 g trans fat` may be stored as zero.

Any implementation that collapses missing values into zero is incorrect.

---

## 2. Do not silently estimate micronutrients

The model may estimate basic nutrition when necessary:

```text
calories
protein_g
carbs_g
fat_g
fiber_g
sugar_g
```

Estimated values must be marked as estimated.

The model must **not automatically estimate**:

```text
saturated_fat_g
trans_fat_g
added_sugar_g
sodium_mg
potassium_mg
cholesterol_mg
calcium_mg
iron_mg
magnesium_mg
vitamin_a_mcg
vitamin_c_mg
vitamin_d_mcg
```

If no trusted value exists, those fields remain `null`.

A missing micronutrient is preferable to a fabricated value.

---

## 3. Every nutrient should have provenance where possible

Nutrient values should record their origin.

Supported sources should include at least:

```text
nutrition_label
open_food_facts
usda_fdc
restaurant_published
user_provided
import
model_estimate
```

Supported confidence classes:

```text
authoritative
user_provided
estimated
```

A meal may contain values from multiple sources.

Example:

```text
calories       = 640       source=model_estimate
protein_g      = 42        source=model_estimate
sodium_mg      = 890       source=restaurant_published
potassium_mg   = null
iron_mg        = null
```

Do not attach one global confidence flag to a meal and imply all nutrients have the same quality.

---

## 4. Authoritative/user values beat estimates

Source precedence:

```text
1. User-provided nutrition label
2. Exact barcode/product nutrition
3. Published restaurant nutrition
4. USDA FoodData Central
5. User-entered nutrient values
6. Model estimation
```

A model-estimated value must never automatically overwrite a value from a more authoritative source.

---

## 5. Normalize units exactly once

All providers must normalize into the canonical nutrient model before the rest of the application consumes the data.

Unit conversion must live in one shared module.

Do not distribute conversion logic across:

- MCP tool handlers;
- analytics;
- widgets;
- imports;
- providers.

If a unit or serving basis cannot be interpreted safely, return `null` rather than guess.

---

# Canonical nutrient model

## Existing nutrients

| Field         | Canonical unit |
| ------------- | -------------: |
| `calories`    |           kcal |
| `protein_g`   |              g |
| `carbs_g`     |              g |
| `fat_g`       |              g |
| `fiber_g`     |              g |
| `sugar_g`     |              g |
| `alcohol_g`   |              g |
| `caffeine_mg` |             mg |

## New nutrients

| Field             | Canonical unit |
| ----------------- | -------------: |
| `saturated_fat_g` |              g |
| `trans_fat_g`     |              g |
| `added_sugar_g`   |              g |
| `sodium_mg`       |             mg |
| `potassium_mg`    |             mg |
| `cholesterol_mg`  |             mg |
| `calcium_mg`      |             mg |
| `iron_mg`         |             mg |
| `magnesium_mg`    |             mg |
| `vitamin_a_mcg`   |         µg RAE |
| `vitamin_c_mg`    |             mg |
| `vitamin_d_mcg`   |             µg |

Do not expand beyond this set until these nutrients work end-to-end.

---

# Provenance model

Add a nullable JSONB field on meals:

```text
nutrient_provenance
```

Recommended format:

```json
{
    "protein_g": {
        "source": "usda_fdc",
        "source_id": "fdc:123456",
        "confidence": "authoritative"
    },
    "sodium_mg": {
        "source": "nutrition_label",
        "source_id": "manual",
        "confidence": "authoritative"
    },
    "carbs_g": {
        "source": "model_estimate",
        "confidence": "estimated"
    }
}
```

Nutrient values themselves should remain normal database columns for efficient querying and aggregation.

Provenance belongs in JSONB so new metadata can be added later without schema explosion.

---

# Orchestrator rules

The orchestrator is responsible for sequencing work, enforcing contracts, routing failed validation back to the correct builder, and refusing to mark work complete until the release gate passes.

## Hard orchestration rules

1. No feature is complete because its builder says it is complete.
2. Every feature must be independently validated by another agent.
3. Provider integrations require deterministic fixture tests **and** live-source validation.
4. All numeric transformations require regression tests.
5. All new nutrient fields must preserve `null != 0`.
6. No live external API calls are allowed in normal unit tests.
7. Live validation is a separate controlled validation step.
8. A validation failure sends the work back to the original builder.
9. The verifier should not silently fix builder code.
10. Only the Integration & Release Agent can mark a feature `DONE`.
11. Full repository tests must pass after integration, not just feature-local tests.
12. The final release must pass end-to-end tests using real sourced foods.

---

# Feature lifecycle

Every feature must follow this exact state machine:

```text
PLANNED
  ↓
BUILDING
  ↓
BUILT
  ↓
UNIT_TESTED
  ↓
INTEGRATION_TESTED
  ↓
REAL_SOURCE_VALIDATED
  ↓
INDEPENDENTLY_VERIFIED
  ↓
INTEGRATED
  ↓
FULL_REGRESSION_PASSED
  ↓
DONE
```

Any failure moves the feature back to the builder:

```text
BUILD
  ↓
TEST
  ↓
VALIDATE AGAINST REAL SOURCE
  ↓
INDEPENDENT VERIFY
  ↓
PASS? ──────────────── yes ──→ INTEGRATE
  │
  no
  ↓
RETURN TO BUILDER
  ↓
FIX ROOT CAUSE
  ↓
RE-RUN FULL FEATURE CYCLE
```

Do not skip earlier validation because a small patch was made after review.

After any correctness fix, the relevant automated tests and real-source validation must be rerun.

---

# Agent ownership

## Agent 0 — Integration & Release

### Owns

- canonical cross-agent contracts;
- branch/merge order;
- dependency enforcement;
- release checklist;
- integration testing;
- full regression suite;
- final evidence package;
- final `DONE` status.

### Must not

- implement major feature functionality owned by other agents;
- waive failed validation;
- accept “works locally” as release evidence.

### Final output

A release report containing:

```text
features completed
PRs/commits integrated
migrations applied
unit test results
integration test results
live validation results
independent verifier results
end-to-end scenarios
known limitations
```

---

# Agent 1 — Canonical nutrient schema and storage

## Objective

Create the canonical database and TypeScript representation for all nutrients and provenance.

This agent owns the nutrient contract used by every later agent.

## Build

Add nullable meal columns for:

```text
saturated_fat_g
trans_fat_g
added_sugar_g

sodium_mg
potassium_mg
cholesterol_mg
calcium_mg
iron_mg
magnesium_mg

vitamin_a_mcg
vitamin_c_mg
vitamin_d_mcg
```

Add:

```text
nutrient_provenance jsonb
```

Requirements:

- no new nutrient column may default to zero;
- add sensible non-negative constraints;
- existing meals must remain valid;
- old meals should expose new fields as null;
- update meal/domain types;
- update storage serialization/deserialization;
- support update and explicit clearing to null.

## Tests

Every field must cover:

```text
undefined -> missing/null
null      -> null
0         -> zero
positive  -> preserved
negative  -> rejected
NaN       -> rejected
Infinity  -> rejected
```

Test:

```text
create -> retrieve
create -> update
create -> clear field to null
old meal -> new schema
```

## Real validation

Insert a manually defined meal containing known macro and micronutrient values into a real test Supabase deployment.

Retrieve it through the same application data-access layer.

Verify every value and `null` survives exactly.

## Done only when

Agent 9 independently reproduces the round trip and confirms no `null → 0` regressions.

---

# Agent 2 — Provider core and unit normalization

## Objective

Create a common abstraction for external nutrition providers.

The rest of the application should not know the provider-specific field layout.

## Build

Create a canonical provider response similar to:

```ts
interface FoodNutrition {
    name: string;
    brand: string | null;

    serving: ServingBasis;

    calories: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    fiber_g: number | null;
    sugar_g: number | null;

    saturated_fat_g: number | null;
    trans_fat_g: number | null;
    added_sugar_g: number | null;

    sodium_mg: number | null;
    potassium_mg: number | null;
    cholesterol_mg: number | null;
    calcium_mg: number | null;
    iron_mg: number | null;
    magnesium_mg: number | null;

    vitamin_a_mcg: number | null;
    vitamin_c_mg: number | null;
    vitamin_d_mcg: number | null;

    source: string;
    sourceId: string;
}
```

Create:

```ts
interface NutritionProvider {
    search?(query: string): Promise<...>;
    lookup(...): Promise<FoodNutrition | null>;
}
```

Create one unit/serving normalization module.

It should cover at minimum:

```text
kg -> g
g -> mg
mg -> mcg

per 100 g -> requested gram serving
per serving -> canonical serving
```

Nutrient-specific conversions such as vitamin units must only be performed when scientifically/dimensionally valid and source semantics are known.

## Tests

Cover:

```text
unit conversion
serving scaling
missing units
invalid values
zero values
per-100g scaling
per-serving preservation
no double scaling
```

## Real validation

Take at least three real nutrient values with known units from an external provider response and run them through the normalization module.

Compare the normalized output manually/independently with expected arithmetic.

## Done only when

Agent 9 independently runs the conversion vectors and attempts adversarial inputs.

---

# Agent 3 — Open Food Facts provider

## Objective

Upgrade barcode-based packaged-food lookup to return the complete supported nutrient model where the source provides it.

## Build

Use the provider abstraction from Agent 2.

Map available Open Food Facts values into:

```text
calories
protein
carbs
fat
fiber
total sugar

saturated fat
trans fat
added sugar

sodium
potassium
cholesterol
calcium
iron
magnesium

vitamin A
vitamin C
vitamin D
```

Retain existing alcohol behavior.

Requirements:

- verify actual provider nutrient keys;
- verify actual provider units;
- normalize via Agent 2;
- missing nutrient -> null;
- malformed nutrient -> null;
- ambiguous nutrient -> null;
- explicit zero -> zero;
- cache normalized results;
- keep provider source IDs.

Use Open Food Facts' current supported product API rather than adding new code directly against deprecated behavior where avoidable.

## Deterministic tests

Create saved fixtures for:

```text
complete packaged food
partial packaged food
per-serving product
per-100g fallback product
explicit zero nutrient
missing nutrient
bad value
bad/missing serving basis
```

No live calls in unit tests.

## Real-source validation

Select at least three real barcoded products:

1. one with a reasonably complete label;
2. one with partial micronutrients;
3. one with a different serving basis.

For each:

```text
live provider response
        ↓
normalization
        ↓
Nutrition MCP food result
        ↓
compare to provider values/label
```

Record barcode, provider response date, source values, normalized values, and any expected unavailable fields.

## Done only when

Agent 9 repeats at least two product validations independently and confirms missing fields do not become zero or estimates.

---

# Agent 4 — USDA FoodData Central provider

## Objective

Provide authoritative nutrition for generic whole foods so the model does not have to estimate micronutrients.

Target examples:

```text
150 g roasted chicken breast
2 large eggs
200 g baked potato
100 g spinach
100 g cooked rice
```

## Build

Add configuration:

```text
USDA_FDC_API_KEY=
```

Implement:

```text
searchFoods(query)
getFood(fdcId)
normalizeNutrients(...)
resolveAmount(...)
```

Support appropriate USDA food datasets for generic foods, including Foundation/FNDDS/legacy records as appropriate.

Do not automatically choose search result #1 when multiple materially different foods exist.

The provider should return candidates with enough metadata for the model or caller to distinguish:

```text
raw vs cooked
skin vs skinless
fortified vs unfortified
brand/generic
preparation method
```

Cache source responses and normalized data.

Prefer storing the raw provider payload in cache as well so normalization can be improved later without losing source information.

## Deterministic tests

Fixtures for:

```text
whole food with extensive micros
food with partial nutrient list
raw/cooked variants
different serving/gram quantities
zero nutrient
missing nutrient
unexpected unit
```

## Real-source validation

Use at least five real foods from USDA.

Suggested validation set:

```text
roasted chicken breast
large whole egg
baked potato
raw spinach
cooked white rice
```

For each food:

1. record FDC ID;
2. record source nutrient values;
3. request a known gram amount;
4. calculate expected scaled values independently;
5. compare to provider normalization;
6. require agreement within explicit rounding tolerance.

## Done only when

Agent 9 independently checks at least three FDC records and confirms both nutrient values and scaling.

---

# Agent 5 — Nutrient resolution policy and MCP write/read behavior

## Objective

Decide which nutrition source wins and expose the expanded model through MCP.

## Source priority

Implement:

```text
1. user-provided nutrition label
2. exact barcode/product source
3. published restaurant nutrition
4. USDA FoodData Central
5. explicit user-entered value
6. model-estimated macros
```

More authoritative values cannot be automatically overwritten by lower-quality sources.

## Model estimation policy

May estimate:

```text
calories
protein_g
carbs_g
fat_g
fiber_g
sugar_g
```

Must mark:

```text
source=model_estimate
confidence=estimated
```

Must not automatically estimate supported micronutrients.

## MCP changes

Update:

```text
log_meal
update_meal
lookup_barcode
food search/lookup behavior
meal retrieval
```

New nutrient fields are optional.

The model must not be forced to supply micros.

Support mixed-source meals.

Support explicit user override.

Support clearing a nutrient back to `null`.

## Tests

Scenarios:

```text
authoritative value beats estimate
user value beats estimate
estimate fills missing macro
estimate does not fill micronutrient
mixed-source provenance survives write/read
update one nutrient leaves others untouched
clear nutrient -> null
```

## Real validation

Run three end-to-end meal logging scenarios:

### Scenario A — Packaged food

```text
barcode
→ source-backed result
→ log meal
→ retrieve meal
→ values and provenance match
```

### Scenario B — Generic whole food

```text
USDA-selected food
→ scale to requested amount
→ log meal
→ retrieve meal
→ values and provenance match
```

### Scenario C — vague conversational meal

```text
"large bowl of chicken pasta"
→ estimated macros allowed
→ unsupported micros remain null
→ provenance says estimated only for estimated fields
```

## Done only when

Agent 9 independently checks all three scenarios.

---

# Agent 6 — Completeness-aware summaries and micronutrient goals

## Objective

Make daily/weekly nutrient summaries accurate even when only some meals have micronutrient data.

Example:

```text
Breakfast sodium: 600 mg
Lunch sodium: unknown
Dinner sodium: 700 mg
```

The system must not imply that the day's true sodium intake is exactly 1,300 mg.

## Build coverage metrics

For each nutrient compute:

```text
known_meals
total_meals

known_calories
total_calories

coverage_fraction
complete
```

Example:

```json
{
    "sodium_mg": {
        "known_total": 1300,
        "known_meals": 2,
        "total_meals": 3,
        "coverage": 0.67,
        "complete": false
    }
}
```

When useful, display:

```text
Sodium: 1,300 mg recorded
Coverage: 67%
```

or:

```text
Sodium: ≥1,300 mg
Known for 2 of 3 meals
```

Do not present an incomplete total as definitive.

## Goals

Add optional goal fields for useful micronutrients.

Suggested:

```text
max_saturated_fat_g
max_sodium_mg
min_potassium_mg
max_cholesterol_mg
min_calcium_mg
min_iron_mg
min_magnesium_mg
min_vitamin_a_mcg
min_vitamin_c_mg
min_vitamin_d_mcg
```

Represent goal direction explicitly:

```text
minimum
maximum
```

Do not hardcode universal medical recommendations into the core product.

## Tests

Cover:

```text
0% coverage
partial coverage
100% coverage
explicit zero nutrient
multiple meals
multiple days
goal min
goal max
missing target
missing intake
```

## Real validation

Create a test day from real OFF/USDA-backed foods with independently computed totals.

Compare:

```text
manual nutrient sum
vs
Nutrition MCP daily summary
```

Then remove one nutrient from one meal and verify the total becomes partial/coverage-aware rather than pretending to be complete.

## Done only when

Agent 9 independently computes the same day's values outside the application and matches them within rounding tolerance.

---

# Agent 7 — Import and export

## Objective

Preserve the expanded nutrient model through migration and backup workflows.

This is especially important for MyFitnessPal migration.

## Export

Include all new nutrient values in:

```text
CSV
full ZIP export
JSON where applicable
```

Include provenance where the format supports it.

## Import

Support common nutrient headings/aliases such as:

```text
Saturated Fat
Sat Fat
Trans Fat
Added Sugar
Added Sugars
Sodium
Potassium
Cholesterol
Calcium
Iron
Magnesium
Vitamin A
Vitamin C
Vitamin D
```

Handle units explicitly:

```text
Sodium (mg)
Sodium (g)
Vitamin D (mcg)
```

Ambiguous units should create a validation error or require mapping.

Never guess.

## Null rules

```text
blank -> null
null  -> null
0     -> 0
```

## Tests

Create representative CSV fixtures including:

```text
complete nutrients
partial nutrients
blank values
zeros
different units
bad units
extra unknown columns
```

## Real validation

Use a sanitized real export or realistic MyFitnessPal-format export.

Perform:

```text
source CSV
  ↓
dry run
  ↓
import
  ↓
query imported meals
  ↓
export
  ↓
re-import into clean test user
  ↓
compare values
```

All supported nutrient values must survive exactly within defined numeric precision.

## Done only when

Agent 9 independently performs the round trip and verifies no supported nutrient changes and no blanks become zero.

---

# Agent 8 — Widgets and user presentation

## Objective

Expose the richer nutrient data without creating an unreadable wall of progress bars.

## UI structure

Recommended hierarchy:

```text
Calories & macros
  Calories
  Protein
  Carbs
  Fat
  Fiber

Micronutrients
  Sodium
  Potassium
  Calcium
  Iron
  Magnesium
  Saturated fat
  Cholesterol
  Vitamin A
  Vitamin C
  Vitamin D
```

Micronutrients may be expandable/collapsible.

## UI correctness rules

UI must visually distinguish:

```text
0
not recorded
partial coverage
complete
estimated
authoritative
```

Do not show:

```text
Iron: 0 mg
```

when the actual state is unknown.

Do not show a green “under sodium goal” indicator when coverage is incomplete unless the UI clearly states the conclusion is based only on recorded values.

## Tests

Add rendering/structured-content tests for:

```text
all micros present
none present
partial coverage
zero value
estimated macro
authoritative micronutrient
historical date
```

## Real validation

Run the UI against the end-to-end validation day used by Agent 6.

Have Agent 9 compare displayed values and coverage labels with the underlying structured response.

## Done only when

Agent 9 confirms UI does not misrepresent missing or partial data.

---

# Agent 9 — Independent validation and adversarial QA

## Role

This agent is the independent verifier for every feature.

It should assume builder output may contain subtle correctness bugs.

It does not approve based only on unit tests written by the builder.

## Responsibilities

For each feature:

1. read the feature's acceptance criteria;
2. inspect implementation and tests;
3. add independent test cases where useful;
4. run the relevant test subset;
5. run full repository tests where appropriate;
6. perform the required real-source validation;
7. compare results independently;
8. report PASS or FAIL with evidence.

If FAIL:

```text
feature -> original builder
```

Agent 9 should report:

```text
reproduction
expected behavior
actual behavior
source/reference values
affected files or interface
severity
```

Agent 9 should not silently patch the builder's code and then approve its own patch.

---

# Agent 0 — Final integration and release gate

After all individual agents are independently approved:

## Integration procedure

1. integrate in dependency order;
2. apply migrations to a clean test database;
3. run:

```bash
bun run format:check
bun run typecheck
bun test
```

4. run a clean-install/deployment smoke test;
5. perform the complete end-to-end validation suite below;
6. require Agent 9 to review integrated behavior;
7. produce final evidence;
8. mark epic complete only if all gates pass.

---

# Required end-to-end release validation

The entire epic is not complete until all of these work against real sources.

## E2E 1 — Packaged barcode food

Select a real packaged food.

Validate:

```text
real barcode
→ Open Food Facts
→ normalized nutrients
→ MCP lookup
→ log meal
→ retrieve meal
→ daily summary
→ export
```

Check returned values against the real source.

Required:

- macro values correct within rounding tolerance;
- available micronutrients correct;
- unavailable nutrients remain null;
- provenance points to OFF;
- export preserves values.

---

## E2E 2 — USDA generic food

Use a real USDA FoodData Central record.

Example:

```text
150 g roasted chicken breast
```

Validate:

```text
USDA record
→ normalized nutrients
→ requested serving scaling
→ log
→ retrieve
→ summary
→ export
```

Independently calculate expected values from the source.

Require agreement within documented rounding tolerance.

---

## E2E 3 — Multi-food day

Build a day from at least four real foods, preferably a mix of:

```text
USDA whole food
packaged OFF food
user-entered label
```

Independently sum:

```text
calories
protein
carbs
fat
fiber
sodium
potassium
calcium
iron
vitamin C
```

Compare against Nutrition MCP daily totals.

---

## E2E 4 — Partial micronutrient coverage

Take the multi-food day and remove sodium data from one meal.

Expected result:

```text
known sodium total remains correct
coverage becomes partial
summary no longer implies full-day sodium is known
```

---

## E2E 5 — Estimated meal

Log a vague meal that lacks an authoritative source.

Expected:

```text
macros may be estimated
estimated macro provenance is recorded
micronutrients are not silently invented
```

---

## E2E 6 — Import/export round trip

Use a realistic MyFitnessPal-style CSV containing supported nutrients.

Validate:

```text
CSV
→ dry run
→ import
→ retrieve
→ export
→ clean database
→ re-import
```

Expected:

```text
values preserved
null remains null
zero remains zero
units preserved through normalization
```

---

# Validation tolerances

The implementation must document numerical tolerance explicitly.

Suggested defaults:

```text
provider source value copied directly:
    exact after canonical rounding

serving multiplication/division:
    <= 0.1 g for gram fields
    <= 1 mg for integer-style mg fields
    <= 1 mcg for integer-style mcg fields

calories:
    <= 1 kcal after expected rounding
```

Do not use a broad percentage tolerance to hide systematic unit or serving errors.

---

# Required validation evidence

Store validation artifacts in the repository under something like:

```text
validation/
  README.md
  open-food-facts/
  usda/
  import/
  e2e/
```

Do not store secrets.

Each live validation record should include:

```text
date validated
source/provider
source identifier
food/product name
serving basis
source nutrient values
normalized expected values
Nutrition MCP actual values
difference
pass/fail
```

Live API responses may be sanitized and stored as fixtures when licensing/terms permit.

The point is to make future regressions reproducible.

---

# CI expectations

Normal CI should run deterministic tests only.

Required:

```bash
bun run format:check
bun run typecheck
bun test
```

Provider unit tests must use fixtures/mocks.

Live validation should be a separate explicit job or operator command so external API availability does not make normal CI flaky.

Recommended commands/scripts:

```text
bun run validate:off
bun run validate:usda
bun run validate:nutrients
bun run validate:e2e
```

These commands should:

- require explicit API credentials where needed;
- never print secrets;
- fail non-zero on mismatches;
- output a human-readable comparison report.

---

# Merge order

Recommended dependency sequence:

```text
Agent 1 — schema
        ↓
Agent 2 — provider core
        ↓
   ┌────┴────┐
   ↓         ↓
Agent 3    Agent 4
OFF        USDA
   └────┬────┘
        ↓
Agent 5 — resolution + MCP
        ↓
   ┌────┴─────────┐
   ↓              ↓
Agent 6          Agent 7
summaries/goals  import/export
   └──────┬───────┘
          ↓
Agent 8 — UI
          ↓
Agent 9 — integrated independent validation
          ↓
Agent 0 — final release gate
```

Agent 3 and Agent 4 may work in parallel after Agent 2's interface is stable.

Agent 6 and Agent 7 may work in parallel after their dependencies are stable.

---

# Global agent prompt

The orchestrator should prepend the following to every builder assignment:

```text
Repository: akutishevsky/nutrition-mcp
Epic: Nutrient Accuracy & Micronutrient Expansion

NON-NEGOTIABLE RULES

1. Unknown nutrient values are NULL, never zero.
2. Zero means the source explicitly reports zero.
3. Do not silently estimate micronutrients.
4. Model-estimated macros must be marked estimated.
5. Authoritative and user-provided values must not be overwritten by estimates.
6. Normalize all provider units to the canonical model before application use.
7. Serving conversion must occur exactly once.
8. Preserve backward compatibility with existing meals.
9. Unit tests must not depend on live external APIs.
10. Real-source validation is mandatory as a separate completion stage.
11. You are not allowed to declare your own feature DONE.
12. Do not modify unrelated OAuth/VPN/infrastructure code.

BEFORE CODING

- Read repository instructions and relevant existing implementation.
- Inspect current tests.
- Trace all serialization/deserialization paths affected.
- Verify provider assumptions from actual source/schema documentation or real responses.
- Identify required migrations and backward-compatibility concerns.

IMPLEMENTATION

- Keep the PR scoped to your assigned feature.
- Add regression tests for every changed behavior.
- Add provider fixtures for external responses.
- Preserve null-vs-zero semantics.
- Fail safely on ambiguous source data or units.
- Do not silently fill missing values.

LOCAL QUALITY GATE

Run:

bun run format:check
bun run typecheck
bun test

FEATURE VALIDATION

Perform the real-source validation defined in your assignment.
Record:
- source identifier
- source values
- expected normalized values
- actual values
- differences
- result

HANDOFF

Report:
- design implemented
- files changed
- migrations
- tests added
- commands/results
- real validation evidence
- known limitations
- anything requiring verifier attention

Status after builder completion is BUILT/VALIDATED, not DONE.
The independent verifier and release agent decide DONE.
```

---

# Definition of Done for the epic

The feature is complete only when all statements below are true:

- [ ] Canonical nutrient schema is deployed and backward compatible.
- [ ] `null` and zero remain distinct everywhere.
- [ ] Provenance is stored per nutrient where applicable.
- [ ] Open Food Facts returns supported packaged-food micros correctly.
- [ ] USDA FoodData Central supports generic whole-food macro/micro lookup.
- [ ] Unit and serving normalization is centralized and independently tested.
- [ ] Estimated macros are clearly identified.
- [ ] Micronutrients are never automatically fabricated by the model.
- [ ] Source precedence prevents estimates from overwriting better data.
- [ ] MCP log/read/update operations support all nutrient fields.
- [ ] Daily summaries calculate macro/micro totals correctly.
- [ ] Partial micronutrient coverage is visible and cannot masquerade as complete.
- [ ] Micronutrient goals support minimum/maximum semantics.
- [ ] Import supports the expanded nutrient set.
- [ ] Export preserves the expanded nutrient set.
- [ ] MyFitnessPal-style import/export round trip passes.
- [ ] Widgets distinguish zero, missing, partial, estimated and authoritative data.
- [ ] Deterministic CI passes.
- [ ] Open Food Facts live validation passes.
- [ ] USDA live validation passes.
- [ ] Multi-food real-data daily-total validation passes.
- [ ] Estimated-meal safety scenario passes.
- [ ] Clean-database migration/deployment test passes.
- [ ] Independent Agent 9 verification passes after final integration.
- [ ] Agent 0 produces release evidence and marks the epic `DONE`.

---

# Expected outcome

After this epic, Nutrition MCP should provide:

- strong calorie and macro tracking;
- meaningful micronutrient tracking;
- authoritative data for packaged and generic whole foods;
- transparent source/provenance information;
- honest handling of missing nutrient data;
- completeness-aware daily/weekly analysis;
- safe AI estimation behavior;
- reliable MyFitnessPal-style migration;
- reproducible real-world validation.

The success criterion is not merely that the application has more nutrient columns.

The success criterion is that a user can inspect a nutrient value and trust:

1. what it means;
2. what unit it uses;
3. where it came from;
4. whether it is estimated;
5. whether the daily total is complete;
6. that the system was tested against real nutrition data before release.
