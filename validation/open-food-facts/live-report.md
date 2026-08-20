# Open Food Facts live validation

Validated: 2026-08-20
Provider: Open Food Facts API v2
Tolerance: exact after canonical rounding (direct copy + unit conversion);
null asserted as null, never as a value near zero.

## 3017620422003 — Nutella — per-100g basis, sub-0.1 g sodium (false-zero trap)

| field | expected | actual | result |
| --- | --- | --- | --- |
| `servingBasis` | {"kind":"per_100g"} | {"kind":"per_100g"} | pass |
| `sodium_mg` | 42.8 | 42.8 | pass |
| `saturated_fat_g` | 10.6 | 10.6 | pass |
| `added_sugar_g` | 52.13 | 52.13 | pass |
| `sugar_g` | 56.3 | 56.3 | pass |
| `trans_fat_g` | null | null | pass |
| `potassium_mg` | null | null | pass |
| `vitamin_c_mg` | null | null | pass |
| `caffeine_mg` | null | null | pass |

## 016000275287 — Cheerios — per-serving basis, explicit zeros

| field | expected | actual | result |
| --- | --- | --- | --- |
| `servingBasis` | {"kind":"per_serving","grams":39,"label":"39g"} | {"kind":"per_serving","grams":39,"label":"39g"} | pass |
| `sodium_mg` | 190 | 190 | pass |
| `saturated_fat_g` | 0.5 | 0.5 | pass |
| `trans_fat_g` | 0 | 0 | pass |
| `cholesterol_mg` | 0 | 0 | pass |
| `added_sugar_g` | 0 | 0 | pass |

## 3387390123210 — Chocapic — per-serving basis, microgram-scale vitamin D

| field | expected | actual | result |
| --- | --- | --- | --- |
| `servingBasis` | {"kind":"per_serving","grams":30,"label":"30 g"} | {"kind":"per_serving","grams":30,"label":"30 g"} | pass |
| `vitamin_d_mcg` | 1.02 | 1.02 | pass |
| `calcium_mg` | 150 | 150 | pass |
| `iron_mg` | 3.6 | 3.6 | pass |
| `sodium_mg` | 24 | 24 | pass |
| `added_sugar_g` | 5.78 | 5.78 | pass |
