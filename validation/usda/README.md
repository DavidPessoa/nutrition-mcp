# USDA FoodData Central — real-source validation (Agent 4)

> **STATUS: VALIDATED AGAINST LIVE DATA — 2026-08-19.**
> `bun run validate:usda` ran clean against the live FoodData Central API
> with a real `USDA_FDC_API_KEY`: five foods, zero mismatches. The fixtures
> under `src/fixtures/usda/` named after a food are the real captured
> payloads, so `bun test` now asserts numbers USDA actually publishes. The
> per-run comparison table is in `live-report.md` (written by the script).
> Read "Still assumed" below before treating this as blanket coverage.

## The records validated

| Food                   | fdcId       | Dataset        | Record                                                  | Amount |
| ---------------------- | ----------- | -------------- | ------------------------------------------------------- | ------ |
| Roasted chicken breast | **171477**  | SR Legacy      | Chicken, broilers or fryers, breast, meat only, roasted | 150 g  |
| Whole raw egg          | **171287**  | SR Legacy      | Egg, whole, raw, fresh                                  | 100 g  |
| Baked potato           | **170111**  | SR Legacy      | Potatoes, baked, flesh and skin, with salt              | 200 g  |
| Raw spinach            | **2709614** | Survey (FNDDS) | Spinach, raw                                            | 100 g  |
| Cooked white rice      | **169708**  | SR Legacy      | Rice, white, long-grain, parboiled, enriched, cooked    | 100 g  |

The synthetic placeholders guessed several of these wrong — most visibly
chicken breast, guessed as 171077 (a real fdcId, but a different chicken)
and carrying a guessed vitamin D of 0.2 µg where the real record says 0.1.

## The 400 that blocked this, and what it actually was

`bun run validate:usda` used to die on a bare nginx `400 Bad Request` with no
JSON body. The cause is **a parenthesis anywhere in the URL query string**:
api.data.gov's edge (which fronts `api.nal.usda.gov`) rejects such requests
intermittently. Measured live on 2026-08-19, same key, back-to-back:

| Request                                        | Result      |
| ---------------------------------------------- | ----------- |
| `?query=spinach`                               | 12/12 → 200 |
| `?query=spinach&dataType=SR%20Legacy`          | 12/12 → 200 |
| `?query=spinach&dataType=Survey`               | 12/12 → 200 |
| `?query=spinach%20(x)`                         | 2/12 → 200  |
| `?query=spinach&dataType=Survey%20(FNDDS)`     | ~50% → 400  |
| `?query=spinach&dataType=Survey%20%28FNDDS%29` | ~50% → 400  |
| `?query=spinach&dataType=Foo(Bar)`             | 10/12 → 200 |

What this rules out, all of which looked plausible first:

- **Not percent-encoding.** `%28`/`%29` fails as often as a literal `(`; the
  edge decodes before filtering.
- **Not comma-joined vs repeated `dataType`.** A comma-joined value answers
  200 just as often. The comment previously in `src/usda.ts` blaming
  comma-joining was wrong — it happened to be a coin flip either way.
- **Not one bad edge node.** Pinning `--resolve` to each A record still gave
  a mix of 200 and 400 from the same IP.
- **Not the query text.** `spinach (x)` fails; `spinach` never does.

It matters beyond `Survey (FNDDS)`: a user searching `chicken (cooked)` would
have hit the same coin flip.

**Fix:** `searchFoods` now uses the documented `POST /v1/foods/search` with
the criteria in a JSON body, leaving only `api_key` in the URL. 12/12 → 200
with the full three-dataset list. `GET /v1/food/{id}` is unchanged — neither
its path nor its params can contain a parenthesis. The regression lock is the
`searchFoods` test asserting the request URL contains no `(`, `)` or `%28`.

## What is now PROVEN by live data

- **Every nutrient number in `NUTRIENT_NUMBERS` except 539** appeared in at
  least one captured record with the unit the mapping expects: 203/204/205/
  291/269/221 in `g`, 262/601/307/306/301/303/304/401 in `mg`, 320/328 in
  `µg`, 605/606 in `g`, 208 in `kcal`.
- **The kJ hazard is real, not theoretical.** Four of the five records carry
  268 Energy in kJ (chicken: 690 kJ beside 165 kcal). Energy is read only
  from 208 with `unitName` kcal.
- **The IU hazard is real too.** Chicken, egg, potato and rice each carry
  318 (Vitamin A, IU) and 324 (Vitamin D, IU) _alongside_ 320 (RAE, µg) and
  328 (µg). The IU entries are dropped; the µg ones are read.
- **Unit names arrive LOWERCASE with a real micro sign** — `"g"`, `"mg"`,
  `"µg"`, `"kcal"` — not the uppercase the published schema shows. The
  case-insensitive `toFdcNutrientUnit` absorbed this; a `switch` on `"UG"`
  alone would have nulled every µg nutrient. Both cases are now tested.
- **Per-100 g holds for SR Legacy and Survey (FNDDS).** Neither carries
  `servingSize`, `servingSizeUnit` or `labelNutrients`; `foodPortions` gives
  gram weights separately, and applying them to the per-100 g figures
  reproduces USDA's own published per-portion numbers (rice 123 kcal × 1.58
  = 194 kcal per cup; egg 143 × 0.44 = 63 kcal per medium egg; potato
  93 × 1.73 = 161 kcal per medium potato).
- **Zero is preserved as zero and absence as null,** on real records: the
  chicken publishes explicit `0` for carbs, fiber, sugar, vitamin C, alcohol
  and caffeine while genuinely omitting trans fat and added sugar. The
  potato publishes trans fat `0`; the rice omits it. `live-report.md`
  asserts null against null, never against a tolerance around zero.
- **Serving scaling is correct at 1.5x and 2x.** The script computes
  `base * grams / 100` itself rather than calling `src/nutrient-units.ts`,
  so the scaler cannot validate itself, and compares with the absolute
  tolerances from `validation/README.md` (≤ 1 kcal, ≤ 0.1 g, ≤ 1 mg,
  ≤ 1 µg) — never a percentage. Every diff came back 0.0000.

## Still ASSUMED — not proven by this run

- **Nutrient 539 (added sugars) has never been seen in a real payload.**
  None of the five foods carries it; it is mapped from the INFOODS tagname
  only. It is carried mainly by Branded records (excluded by default) and a
  minority of FNDDS ones. `added_sugar_g` from FDC is therefore unverified.
- **No Foundation record is in the five-food `live-report.md` set** — all
  five resolved to SR Legacy or Survey (FNDDS). Foundation is now covered by
  a committed real fixture instead (fdcId 2685576, "Beets, raw", captured
  2026-08-19): per-100 g, same lowercase units, and the energy case below is
  resolved rather than left open.
- **Branded and `labelNutrients` remain entirely unexercised.** Out of scope
  by design (Open Food Facts owns barcoded product), so no claim is made.
- **The cache path (`lookupFood`, `food_cache`) was not exercised live.**
  The validation script calls `fetchFoodFromFdc` directly; only the
  Supabase-free path is covered here.

## Other live finding

FDC's search index and its detail endpoint are not in sync: fdcId **747447**
("Broccoli, raw", Foundation) is returned by `/foods/search` and returns
`404` from `/food/747447`, reproducibly (5/5). `fdcFetch` now maps 404 to
`null` so a dead link is an empty lookup rather than a thrown tool error.

## Re-running it

```bash
# free key, no card: https://fdc.nal.usda.gov/api-key-signup.html
echo "USDA_FDC_API_KEY=..." >> .env    # .env is gitignored
bun run validate:usda
```

It re-captures each record into `src/fixtures/usda/`, re-checks the scaling,
rewrites `live-report.md` and exits non-zero on any mismatch. It never prints
the key — the key travels in the query string, so API errors report a status
code only, never the URL. If a captured fixture changes, USDA republished the
record: review the diff and update `src/usda.test.ts`; a mismatch there is a
finding, not a chore.

Candidate selection is explicit and recorded in the report: for these queries
FDC returns materially different records (raw vs cooked, skin-on vs skinless,
with salt vs without), and `searchFoods` deliberately does not pick one.

## Foundation energy: a decision, not an oversight

`Beets, raw` (fdcId 2685576, Foundation) carries **no nutrient 208 at all**.
Its only energy figures are 957 (Atwater General, 44.6205 kcal/100 g) and
958 (Atwater Specific, 40.965255). Refusing both would return `calories:
null` for a plain whole food — precisely the case this provider exists to
answer — so energy is read in the order **208 → 957 → 958**.

Why 957 before 958: the general factors are the familiar 4/4/9 convention
and are what USDA shows first, so every food's calories stay comparable with
every other food's. Specific factors are more accurate per food but mixing
the two conventions inside one daily total is silently incoherent.

The unit check is unchanged and still absolute: an energy entry whose
`unitName` is not `kcal` is refused whatever its number, so widening the
accepted numbers cannot let a kilojoule figure through. Covered by tests
against the real captured record.

## Known limitations (by design)

- **Vitamin A and vitamin D in IU are dropped, not converted.** There is no
  single valid IU → µg RAE factor (see `src/nutrient-units.ts`). A record
  carrying only the IU form yields `null`.
- **Energy prefers 208, then falls back to 957 and 958** — all kcal, never
  268 (kJ). See "Foundation energy" above for why, and what the ordering
  costs.
- **`Branded` is excluded from the default search datasets.** A caller can
  still pass it explicitly.
- **`labelNutrients` is not read.** Mixing per-serving label figures with
  per-100 g `foodNutrients` in one result is exactly the double-basis bug
  the serving contract exists to prevent.
