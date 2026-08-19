# USDA FoodData Central — real-source validation (Agent 4)

> **STATUS: NOT YET VALIDATED AGAINST LIVE DATA.**
> No `USDA_FDC_API_KEY` was available when this provider was built, and the
> shared `DEMO_KEY` was returning `OVER_RATE_LIMIT`. Everything below is
> ready to run; nothing below has run. Agent 4's real-source gate is
> formally UNMET until it does.

## What is unverified, precisely

| Verified from                    | What                                                                                                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| USDA's published OpenAPI v3 spec | Endpoint paths, both `foodNutrients` shapes (nested `nutrient.{number,name,unitName}` + `amount` on detail; flat `{number,name,unitName,amount}` on search), the `dataType` enum, `foodPortions` |
| Long-stable INFOODS tagnames     | The nutrient NUMBERS in `NUTRIENT_NUMBERS` (`src/usda.ts`)                                                                                                                                       |
| **Nothing**                      | That a live record actually uses those numbers with those units, and that the per-100 g basis assumption holds for every dataset                                                                 |

The mapping is written defensively for exactly that reason: the unit is read
from each nutrient's own `unitName` rather than assumed, and anything not
confidently `G`/`MG`/`UG` yields `null`. A wrong assumption should therefore
produce a missing nutrient, not a wrong number — but "should" is not
"validated".

## Running it

```bash
# free key, no card: https://fdc.nal.usda.gov/api-key-signup.html
echo "USDA_FDC_API_KEY=..." >> .env    # .env is gitignored
bun run validate:usda
```

The script does two things:

1. **Captures** the real record for each food into `src/fixtures/usda/`,
   replacing the synthetic placeholders committed today. Review that diff —
   it is the moment the deterministic tests start asserting real data. The
   expected values in `src/usda.test.ts` will need updating to match, and
   any mismatch there is a finding, not a chore.
2. **Compares** each record scaled to a requested gram amount against
   arithmetic done inside the script itself, independently of
   `src/nutrient-units.ts`, so a bug in the scaler cannot validate itself.

It writes `live-report.md` here and exits non-zero on any mismatch. It never
prints the key (the key travels in the query string, so API errors report a
status code only, never the URL).

## Foods and amounts

The set the epic names, each at a gram amount that is not 100 g wherever
possible — scaling by 1.0 would validate nothing:

| Food                   | Query                                          | Amount |
| ---------------------- | ---------------------------------------------- | ------ |
| Roasted chicken breast | `chicken breast roasted` (prefers "meat only") | 150 g  |
| Whole raw egg          | `egg whole raw fresh`                          | 100 g  |
| Baked potato           | `potato baked flesh and skin`                  | 200 g  |
| Raw spinach            | `spinach raw`                                  | 100 g  |
| Cooked white rice      | `rice white long-grain cooked`                 | 100 g  |

Candidate selection is explicit and recorded in the report: for these
queries FDC returns materially different records (raw vs cooked, skin-on vs
skinless), and `searchFoods` deliberately does not pick one.

## Tolerances

Absolute, from `validation/README.md`: ≤ 1 kcal, ≤ 0.1 g, ≤ 1 mg, ≤ 1 µg.
`null` is compared as `null`, separately — "within 1 mg of zero" is never a
pass for a nutrient the record does not carry.

## Known limitations

- **Vitamin A and vitamin D in IU are dropped, not converted.** FDC carries
  318 (A, IU) and 324 (D, IU) alongside 320 (A, RAE) and 328 (D, µg). Only
  the µg entries are read; a record carrying only the IU form yields `null`.
  There is no single valid IU → µg RAE factor (see `src/nutrient-units.ts`).
- **Energy is read only from nutrient 208 with `unitName` KCAL.** FDC
  reports the same food under 268 (kJ) and, for Foundation foods, 957/958
  (Atwater kcal variants). Accepting those would make "where did this
  calorie figure come from" unanswerable; the cost is a `null` on the rare
  record that carries no plain 208.
- **`Branded` is excluded from the default search datasets.** Barcoded
  packaged food is Open Food Facts' job. A caller can still pass it
  explicitly.
- **`labelNutrients` is not read.** Branded records carry per-serving label
  figures there; mixing them with the per-100 g `foodNutrients` inside one
  result is precisely the double-basis bug the serving contract exists to
  prevent.
