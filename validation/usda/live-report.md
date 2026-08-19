# USDA FoodData Central live validation

Validated: 2026-08-19
Provider: FoodData Central API v1
Basis: every FDC dataset reports foodNutrients per 100 g.
Tolerance: <= 1 kcal, <= 0.1 g, <= 1 mg, <= 1 mcg (absolute).
null is asserted as null, never as a value near zero.

## chicken-breast-roasted — fdcId 171477

Record: Chicken, broilers or fryers, breast, meat only, cooked, roasted (SR Legacy)
Basis: per 100 g. Requested: 150 g.

| nutrient          | per 100 g (source) | expected @ serving | actual | diff   | result |
| ----------------- | ------------------ | ------------------ | ------ | ------ | ------ |
| `calories`        | 165                | 247.500            | 247.5  | 0.0000 | pass   |
| `protein_g`       | 31.02              | 46.530             | 46.53  | 0.0000 | pass   |
| `carbs_g`         | 0                  | 0.000              | 0      | 0.0000 | pass   |
| `fat_g`           | 3.57               | 5.355              | 5.355  | 0.0000 | pass   |
| `fiber_g`         | 0                  | 0.000              | 0      | 0.0000 | pass   |
| `sugar_g`         | 0                  | 0.000              | 0      | 0.0000 | pass   |
| `alcohol_g`       | 0                  | 0.000              | 0      | 0.0000 | pass   |
| `caffeine_mg`     | 0                  | 0.000              | 0      | 0.0000 | pass   |
| `saturated_fat_g` | 1.01               | 1.515              | 1.515  | 0.0000 | pass   |
| `sodium_mg`       | 74                 | 111.000            | 111    | 0.0000 | pass   |
| `potassium_mg`    | 256                | 384.000            | 384    | 0.0000 | pass   |
| `cholesterol_mg`  | 85                 | 127.500            | 127.5  | 0.0000 | pass   |
| `calcium_mg`      | 15                 | 22.500             | 22.5   | 0.0000 | pass   |
| `iron_mg`         | 1.04               | 1.560              | 1.56   | 0.0000 | pass   |
| `magnesium_mg`    | 29                 | 43.500             | 43.5   | 0.0000 | pass   |
| `vitamin_a_mcg`   | 6                  | 9.000              | 9      | 0.0000 | pass   |
| `vitamin_c_mg`    | 0                  | 0.000              | 0      | 0.0000 | pass   |
| `vitamin_d_mcg`   | 0.1                | 0.150              | 0.15   | 0.0000 | pass   |

## egg-whole-raw — fdcId 171287

Record: Egg, whole, raw, fresh (SR Legacy)
Basis: per 100 g. Requested: 100 g.

| nutrient          | per 100 g (source) | expected @ serving | actual | diff   | result |
| ----------------- | ------------------ | ------------------ | ------ | ------ | ------ |
| `calories`        | 143                | 143.000            | 143    | 0.0000 | pass   |
| `protein_g`       | 12.56              | 12.560             | 12.56  | 0.0000 | pass   |
| `carbs_g`         | 0.72               | 0.720              | 0.72   | 0.0000 | pass   |
| `fat_g`           | 9.51               | 9.510              | 9.51   | 0.0000 | pass   |
| `fiber_g`         | 0                  | 0.000              | 0      | 0.0000 | pass   |
| `sugar_g`         | 0.37               | 0.370              | 0.37   | 0.0000 | pass   |
| `alcohol_g`       | 0                  | 0.000              | 0      | 0.0000 | pass   |
| `caffeine_mg`     | 0                  | 0.000              | 0      | 0.0000 | pass   |
| `saturated_fat_g` | 3.126              | 3.126              | 3.126  | 0.0000 | pass   |
| `trans_fat_g`     | 0.038              | 0.038              | 0.038  | 0.0000 | pass   |
| `sodium_mg`       | 142                | 142.000            | 142    | 0.0000 | pass   |
| `potassium_mg`    | 138                | 138.000            | 138    | 0.0000 | pass   |
| `cholesterol_mg`  | 372                | 372.000            | 372    | 0.0000 | pass   |
| `calcium_mg`      | 56                 | 56.000             | 56     | 0.0000 | pass   |
| `iron_mg`         | 1.75               | 1.750              | 1.75   | 0.0000 | pass   |
| `magnesium_mg`    | 12                 | 12.000             | 12     | 0.0000 | pass   |
| `vitamin_a_mcg`   | 160                | 160.000            | 160    | 0.0000 | pass   |
| `vitamin_c_mg`    | 0                  | 0.000              | 0      | 0.0000 | pass   |
| `vitamin_d_mcg`   | 2                  | 2.000              | 2      | 0.0000 | pass   |

## potato-baked — fdcId 170111

Record: Potatoes, baked, flesh and skin, with salt (SR Legacy)
Basis: per 100 g. Requested: 200 g.

| nutrient          | per 100 g (source) | expected @ serving | actual | diff   | result |
| ----------------- | ------------------ | ------------------ | ------ | ------ | ------ |
| `calories`        | 93                 | 186.000            | 186    | 0.0000 | pass   |
| `protein_g`       | 2.5                | 5.000              | 5      | 0.0000 | pass   |
| `carbs_g`         | 21.15              | 42.300             | 42.3   | 0.0000 | pass   |
| `fat_g`           | 0.13               | 0.260              | 0.26   | 0.0000 | pass   |
| `fiber_g`         | 2.2                | 4.400              | 4.4    | 0.0000 | pass   |
| `sugar_g`         | 1.18               | 2.360              | 2.36   | 0.0000 | pass   |
| `alcohol_g`       | 0                  | 0.000              | 0      | 0.0000 | pass   |
| `caffeine_mg`     | 0                  | 0.000              | 0      | 0.0000 | pass   |
| `saturated_fat_g` | 0.034              | 0.068              | 0.068  | 0.0000 | pass   |
| `trans_fat_g`     | 0                  | 0.000              | 0      | 0.0000 | pass   |
| `sodium_mg`       | 10                 | 20.000             | 20     | 0.0000 | pass   |
| `potassium_mg`    | 535                | 1070.000           | 1070   | 0.0000 | pass   |
| `cholesterol_mg`  | 0                  | 0.000              | 0      | 0.0000 | pass   |
| `calcium_mg`      | 15                 | 30.000             | 30     | 0.0000 | pass   |
| `iron_mg`         | 1.08               | 2.160              | 2.16   | 0.0000 | pass   |
| `magnesium_mg`    | 28                 | 56.000             | 56     | 0.0000 | pass   |
| `vitamin_a_mcg`   | 1                  | 2.000              | 2      | 0.0000 | pass   |
| `vitamin_c_mg`    | 9.6                | 19.200             | 19.2   | 0.0000 | pass   |
| `vitamin_d_mcg`   | 0                  | 0.000              | 0      | 0.0000 | pass   |

## spinach-raw — fdcId 2709614

Record: Spinach, raw (Survey (FNDDS))
Basis: per 100 g. Requested: 100 g.

| nutrient          | per 100 g (source) | expected @ serving | actual | diff   | result |
| ----------------- | ------------------ | ------------------ | ------ | ------ | ------ |
| `calories`        | 27                 | 27.000             | 27     | 0.0000 | pass   |
| `protein_g`       | 2.85               | 2.850              | 2.85   | 0.0000 | pass   |
| `carbs_g`         | 2.41               | 2.410              | 2.41   | 0.0000 | pass   |
| `fat_g`           | 0.62               | 0.620              | 0.62   | 0.0000 | pass   |
| `fiber_g`         | 1.6                | 1.600              | 1.6    | 0.0000 | pass   |
| `sugar_g`         | 0.42               | 0.420              | 0.42   | 0.0000 | pass   |
| `alcohol_g`       | 0                  | 0.000              | 0      | 0.0000 | pass   |
| `caffeine_mg`     | 0                  | 0.000              | 0      | 0.0000 | pass   |
| `saturated_fat_g` | 0.063              | 0.063              | 0.063  | 0.0000 | pass   |
| `sodium_mg`       | 111                | 111.000            | 111    | 0.0000 | pass   |
| `potassium_mg`    | 582                | 582.000            | 582    | 0.0000 | pass   |
| `cholesterol_mg`  | 0                  | 0.000              | 0      | 0.0000 | pass   |
| `calcium_mg`      | 68                 | 68.000             | 68     | 0.0000 | pass   |
| `iron_mg`         | 1.26               | 1.260              | 1.26   | 0.0000 | pass   |
| `magnesium_mg`    | 93                 | 93.000             | 93     | 0.0000 | pass   |
| `vitamin_a_mcg`   | 283                | 283.000            | 283    | 0.0000 | pass   |
| `vitamin_c_mg`    | 26.5               | 26.500             | 26.5   | 0.0000 | pass   |
| `vitamin_d_mcg`   | 0                  | 0.000              | 0      | 0.0000 | pass   |

## rice-white-cooked — fdcId 169708

Record: Rice, white, long-grain, parboiled, enriched, cooked (SR Legacy)
Basis: per 100 g. Requested: 100 g.

| nutrient          | per 100 g (source) | expected @ serving | actual | diff   | result |
| ----------------- | ------------------ | ------------------ | ------ | ------ | ------ |
| `calories`        | 123                | 123.000            | 123    | 0.0000 | pass   |
| `protein_g`       | 2.91               | 2.910              | 2.91   | 0.0000 | pass   |
| `carbs_g`         | 26.05              | 26.050             | 26.05  | 0.0000 | pass   |
| `fat_g`           | 0.37               | 0.370              | 0.37   | 0.0000 | pass   |
| `fiber_g`         | 0.9                | 0.900              | 0.9    | 0.0000 | pass   |
| `sugar_g`         | 0.11               | 0.110              | 0.11   | 0.0000 | pass   |
| `alcohol_g`       | 0                  | 0.000              | 0      | 0.0000 | pass   |
| `caffeine_mg`     | 0                  | 0.000              | 0      | 0.0000 | pass   |
| `saturated_fat_g` | 0.074              | 0.074              | 0.074  | 0.0000 | pass   |
| `sodium_mg`       | 2                  | 2.000              | 2      | 0.0000 | pass   |
| `potassium_mg`    | 56                 | 56.000             | 56     | 0.0000 | pass   |
| `cholesterol_mg`  | 0                  | 0.000              | 0      | 0.0000 | pass   |
| `calcium_mg`      | 19                 | 19.000             | 19     | 0.0000 | pass   |
| `iron_mg`         | 1.81               | 1.810              | 1.81   | 0.0000 | pass   |
| `magnesium_mg`    | 9                  | 9.000              | 9      | 0.0000 | pass   |
| `vitamin_a_mcg`   | 0                  | 0.000              | 0      | 0.0000 | pass   |
| `vitamin_c_mg`    | 0                  | 0.000              | 0      | 0.0000 | pass   |
| `vitamin_d_mcg`   | 0                  | 0.000              | 0      | 0.0000 | pass   |
