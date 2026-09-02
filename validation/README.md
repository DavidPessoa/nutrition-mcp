# Validation evidence

Deterministic tests (`bun test`) prove the code does what we wrote down.
This directory holds the other half: evidence that what we wrote down matches
**real nutrition data**.

Nothing here runs in normal CI. Live validation is a separate, explicit
operator command so a third-party API outage can never make CI flaky:

```bash
bun run validate:off        # Open Food Facts, real barcodes
bun run validate:usda       # USDA FoodData Central, real FDC ids
bun run validate:nutrients  # normalization vectors, no network
bun run validate:e2e        # full end-to-end scenarios
```

Each command requires its credentials to be present, never prints a secret,
exits non-zero on any mismatch, and writes a human-readable comparison report
into the matching subdirectory.

## Credentials

| Variable                              | Needed by       | Notes                                                         |
| ------------------------------------- | --------------- | ------------------------------------------------------------- |
| `OFF_USER_AGENT`                      | `validate:off`  | Open Food Facts requires `AppName (contact@email)`.           |
| `USDA_FDC_API_KEY`                    | `validate:usda` | Free key from <https://fdc.nal.usda.gov/api-key-signup.html>. |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | `validate:e2e`  | Point at a **test** project, never production.                |

Do not commit any of these. `.env` is gitignored.

## Tolerances

These are the documented numeric tolerances every live validation asserts
against. They are deliberately absolute, not percentage-based — a broad
percentage tolerance is exactly what hides a systematic unit or serving-basis
error, which is the class of bug this epic exists to prevent.

| Case                                         | Tolerance                         |
| -------------------------------------------- | --------------------------------- |
| Provider value copied directly               | exact, after canonical rounding   |
| Serving multiplication/division, gram fields | <= 0.1 g                          |
| Serving multiplication/division, mg fields   | <= 1 mg                           |
| Serving multiplication/division, mcg fields  | <= 1 mcg                          |
| Calories                                     | <= 1 kcal after expected rounding |

A value that is `null` at the source must be `null` in the result. "Within
tolerance of zero" is **not** a pass for a missing nutrient — `null` and `0`
are different assertions and are checked separately.

## What a validation record must contain

Every record stored here is a small JSON or Markdown file carrying:

```
date validated
source / provider
source identifier        (barcode, FDC id)
food / product name
serving basis            (per 100 g, per serving + gram weight)
source nutrient values   (as the provider reported them)
normalized expected      (worked out independently of our code)
actual values            (what Nutrition MCP produced)
difference
pass / fail
```

The point is reproducibility: a future regression should be diagnosable from
these files alone, without re-deriving what the source said on the day.

## Layout

```
validation/
  README.md            this file
  open-food-facts/     real barcode products (Agent 3)
  usda/                real FDC records (Agent 4)
  import/              MyFitnessPal-style round trips (Agent 7)
  e2e/                 the six end-to-end release scenarios
```

Sanitized live API responses may be stored as fixtures where licensing permits;
those live under `src/fixtures/` so `bun test` can use them offline.
