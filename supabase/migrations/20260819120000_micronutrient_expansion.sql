-- Micronutrient expansion: twelve more per-meal nutrients, plus a place to
-- record where each nutrient value on a meal actually came from. This is the
-- foundation for label/barcode/USDA-backed accuracy work — until now every
-- meal beyond the six macros could only carry fiber, sugar, alcohol and
-- caffeine.
--
-- Every statement here is additive and every new column is nullable, so this
-- is safe to apply to the populated production tables: no existing row is
-- rewritten, no existing row is invalidated by the new checks (NULL passes a
-- check constraint), and every current write path keeps working unchanged
-- before the server that knows about these columns ships. The reverse order —
-- server first, migration second — is what breaks, so this lands first.

-- All twelve are `numeric` — never integer, since a fortified cereal's iron or
-- a supplement-grade vitamin D routinely carries a fraction, and matching the
-- existing per-meal nutrient columns (fiber_g, sugar_g, alcohol_g,
-- caffeine_mg are all bare `numeric` too). Nullable with NO default: the
-- overwhelming majority of logged meals will carry none of these, and NULL
-- means "not recorded, unknown" — never zero. A read path that averages an
-- unrecorded meal in as 0 mg silently understates every other meal's real
-- contribution to the day; see the nutrient model's non-negotiable
-- invariants. Each check allows exactly zero (a food can genuinely contain
-- 0 mg sodium) and rejects negative values, mirroring caffeine_mg and the
-- fiber/sugar/alcohol trio before it.
--
-- The unit rides in every column name, exactly as caffeine_mg's does, because
-- this table now mixes three different units (g, mg, mcg) on top of the
-- existing kcal `calories` column — a bare `vitamin_d` column would be one
-- silent order-of-magnitude bug waiting to happen: a 20 mcg (µg) daily value
-- entered as 20 mg is a thousandfold overdose in the stored number. Fat-
-- soluble vitamin_a and vitamin_d are stored in µg — vitamin_a as µg RAE
-- (retinol activity equivalents), the unit every label and USDA FoodData
-- Central record already uses — never as IU, since IU-to-µg depends on the
-- specific retinoid/tocopherol form and so must be converted (in exactly one
-- module, src/nutrient-units.ts) before a value ever reaches this column.
--
-- sugar_g (already on this table) stays TOTAL sugars. added_sugar_g below is
-- a separate figure and is never derived from it: "how much of the total is
-- added" is exactly the number a nutrition label states outright, and one a
-- barcode or recipe lookup usually cannot reconstruct from the total alone.
alter table public.meals
    add column if not exists saturated_fat_g numeric check (saturated_fat_g >= 0),
    add column if not exists trans_fat_g numeric check (trans_fat_g >= 0),
    add column if not exists added_sugar_g numeric check (added_sugar_g >= 0),
    add column if not exists sodium_mg numeric check (sodium_mg >= 0),
    add column if not exists potassium_mg numeric check (potassium_mg >= 0),
    add column if not exists cholesterol_mg numeric check (cholesterol_mg >= 0),
    add column if not exists calcium_mg numeric check (calcium_mg >= 0),
    add column if not exists iron_mg numeric check (iron_mg >= 0),
    add column if not exists magnesium_mg numeric check (magnesium_mg >= 0),
    add column if not exists vitamin_a_mcg numeric check (vitamin_a_mcg >= 0),
    add column if not exists vitamin_c_mg numeric check (vitamin_c_mg >= 0),
    add column if not exists vitamin_d_mcg numeric check (vitamin_d_mcg >= 0);

-- Per-nutrient provenance: which source populated each field on this meal,
-- and how much to trust it, keyed by the canonical field name, e.g.
--   {"sodium_mg": {"source": "usda_fdc", "source_id": "fdc:123456",
--                   "confidence": "authoritative"}}
-- Deliberately PER-NUTRIENT rather than one flag on the whole meal: a single
-- log_meal call can blend a barcode-scanned product (authoritative sodium)
-- with a model-estimated side dish (estimated calories), and collapsing that
-- to one meal-level confidence would either overstate the estimate or throw
-- away the barcode hit's precision. Nullable — most meals, including every
-- meal logged before this shipped and any plain calories/protein/carbs/fat
-- entry, carry no provenance at all.
--
-- Postgres enforces nothing here beyond "valid JSON" — the field names,
-- source vocabulary and confidence vocabulary are TypeScript-level contracts
-- (src/nutrients.ts), and parseNutrientProvenance there degrades unrecognised
-- keys, unknown source/confidence strings, or hand-edited garbage to null
-- rather than throwing, so a malformed row can never crash a read.
alter table public.meals
    add column if not exists nutrient_provenance jsonb;
