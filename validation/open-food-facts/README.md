# Open Food Facts — real-source validation (Agent 3)

What is being validated: that the twelve new micronutrients read out of Open
Food Facts land in the canonical model with the right **key**, the right
**unit**, and the right **serving basis** — and that a nutrient the source
never reported stays `null` rather than becoming `0`.

```bash
export OFF_USER_AGENT="nutrition-mcp/1.25.0 (you@example.com)"
bun run validate:off
```

The command fetches the three products below live, through the same
`fetchProductFromOFF` the MCP server uses, compares against the hand-derived
values in this file, writes `live-report.md`, and exits non-zero on any
mismatch. It is never part of `bun test`.

## What the provider actually reports

Verified against the live API on **2026-08-19**, not assumed:

- Nutrient amounts come as `<key>_100g` and (when the product has a serving)
  `<key>_serving`; the unit those numbers are in is the sibling `<key>_unit`.
- Every micronutrient `_unit` observed on every product sampled was **`g`** —
  including for nutrients whose canonical unit is mg or µg. Sodium is reported
  as `0.0428` grams, not `42.8` milligrams. Vitamin D as `0.0000034` grams.
- Key spellings are hyphenated: `saturated-fat`, `trans-fat`, `added-sugars`,
  `vitamin-a`, `vitamin-c`, `vitamin-d`; the minerals are unhyphenated single
  words.
- `added-sugars` is a separate key from `sugars`. Total sugar is never used to
  derive added sugar.

The code still reads each product's own `_unit` rather than hardcoding `g`,
so a future product reporting vitamin A in `IU` resolves to `null` instead of
a wrong number (there is no single IU → µg RAE factor; see
`src/nutrient-units.ts`).

## Products and hand-derived expectations

Captured responses live in `src/fixtures/off/` so `bun test` can assert the
same numbers offline. Recapture with:

```bash
curl -s -A "$OFF_USER_AGENT" \
  "https://world.openfoodfacts.org/api/v2/product/<barcode>?fields=product_name,brands,serving_size,serving_quantity,serving_quantity_unit,nutriments"
```

### 1. Nutella — `3017620422003` — reasonably complete label, per-100 g

No `serving_size`, so every figure is on the per-100 g basis.

| nutrient          | source value  | unit | expected canonical | derivation               |
| ----------------- | ------------- | ---- | ------------------ | ------------------------ |
| `sodium_mg`       | 0.0428        | g    | **42.8 mg**        | × 1000                   |
| `saturated_fat_g` | 10.6          | g    | 10.6 g             | direct copy              |
| `added_sugar_g`   | 52.13         | g    | 52.13 g            | direct copy              |
| `sugar_g` (total) | 56.3          | g    | 56.3 g             | separate key             |
| `trans_fat_g`     | _not present_ | —    | **null**           | unknown ≠ zero           |
| `potassium_mg`    | _not present_ | —    | **null**           | unknown ≠ zero           |
| `vitamin_c_mg`    | _not present_ | —    | **null**           | unknown ≠ zero           |
| `caffeine_mg`     | _no such key_ | —    | **null**           | OFF has no caffeine data |

This product is the reason the micronutrient path does not round before
converting: `0.0428` rounded to one decimal is `0.0`, and `0.0 g` converts to
`0 mg` — a real 42.8 mg value replaced by a confident zero.

### 2. Cheerios — `016000275287` — partial micros, per-serving, explicit zeros

`serving_size: "39g"`, `serving_quantity: 39`, `serving_quantity_unit: "g"`,
and a per-serving energy — so the per-serving basis wins and
`servingBasis.grams` is 39.

| nutrient          | source value (`_serving`) | unit | expected             |
| ----------------- | ------------------------- | ---- | -------------------- |
| `sodium_mg`       | 0.19                      | g    | **190 mg**           |
| `saturated_fat_g` | 0.5                       | g    | 0.5 g                |
| `trans_fat_g`     | 0                         | g    | **0** (zero is data) |
| `cholesterol_mg`  | 0                         | g    | **0**                |
| `added_sugar_g`   | 0                         | g    | **0**                |

The per-100 g figures differ (sodium `0.487…` g → 487 mg), so reading the
wrong basis is visible rather than plausible.

### 3. Chocapic — `3387390123210` — different serving basis, µg-scale vitamin

`serving_size: "30 g"`.

| nutrient        | source value (`_serving`) | unit | expected    | derivation |
| --------------- | ------------------------- | ---- | ----------- | ---------- |
| `vitamin_d_mcg` | 0.00000102                | g    | **1.02 µg** | × 1e6      |
| `calcium_mg`    | 0.15                      | g    | **150 mg**  | × 1000     |
| `iron_mg`       | 0.0036                    | g    | **3.6 mg**  | × 1000     |
| `sodium_mg`     | 0.024                     | g    | **24 mg**   | × 1000     |
| `added_sugar_g` | 5.78                      | g    | 5.78 g      | direct     |

Vitamin D is the floating-point case: `0.00000102 × 1e6` evaluates to
`1.0200000000000002` before the noise guard in `src/nutrient-units.ts`.

## Known limitations

- **Vitamin C was not observed populated** on any product sampled. Its key
  spelling is confirmed from OFF's own `data-fields.txt` and it is read
  through the identical dynamic-unit path as every other micronutrient, but
  no live product has exercised it. Worth revisiting if a fortified product
  turns up.
- **Vitamin A in IU is untested live** for the same reason — no sampled
  product reported it that way. The behaviour (unknown unit → `null`) is
  covered deterministically by `src/fixtures/off/unknown-units.json`.
- Open Food Facts is crowd-sourced: a product's values can change between
  runs. A mismatch here is not automatically a code regression — check the
  live response before assuming it is.
