-- Micronutrient goals: an optional daily floor or ceiling per micronutrient.
--
-- Additive and nullable throughout, exactly like the caffeine migration, so it
-- is safe to apply to the populated production table ahead of the server that
-- knows about the columns: no existing row is rewritten, NULL passes every new
-- check, and every current write path keeps working unchanged.
--
-- THE DIRECTION IS IN THE COLUMN NAME, and that is not cosmetic. The existing
-- goal columns are all `daily_*` and their direction lives in application code
-- (formatGoalLine's floor/ceiling argument in src/mcp.ts) — which is how a 0 g
-- alcohol limit came to be stored, echoed back, and then silently ignored on
-- every progress line. Sodium and saturated fat are ceilings; potassium,
-- calcium, iron, magnesium and the vitamins are floors, and the two read
-- oppositely in every sentence a user sees ("140 mg to go" is encouragement
-- against a floor and a permission slip against a ceiling). Encoding it in the
-- name means no layer can guess wrong and no second lookup table can drift.
--
-- NO DEFAULTS, deliberately. There are widely published reference intakes for
-- every one of these, and hardcoding them would turn a tracking tool into a
-- source of dietary advice for a user who never asked. The user sets their own
-- number or has none; NULL means "no target", which every read path already
-- knows how to render as "not set".
--
-- Precision mirrors the existing goal columns: numeric(6,2) for gram targets
-- (the same cap daily_protein_g and friends carry) and numeric(7,2) for the mg
-- and mcg ones, since those figures run orders of magnitude larger — the same
-- reason daily_caffeine_mg got the extra integer digit.
--
-- Zero is a real target on a ceiling ("none at all") and meaningless on a
-- floor, but the check allows it in both directions for the same reason the
-- existing columns do: the floor-vs-unset judgement is hasActiveTarget's, in
-- one place, not a constraint the database re-litigates.

alter table public.nutrition_goals
    add column if not exists max_saturated_fat_g numeric(6, 2) check (max_saturated_fat_g >= 0),
    add column if not exists max_sodium_mg numeric(7, 2) check (max_sodium_mg >= 0),
    add column if not exists min_potassium_mg numeric(7, 2) check (min_potassium_mg >= 0),
    add column if not exists max_cholesterol_mg numeric(7, 2) check (max_cholesterol_mg >= 0),
    add column if not exists min_calcium_mg numeric(7, 2) check (min_calcium_mg >= 0),
    add column if not exists min_iron_mg numeric(7, 2) check (min_iron_mg >= 0),
    add column if not exists min_magnesium_mg numeric(7, 2) check (min_magnesium_mg >= 0),
    add column if not exists min_vitamin_a_mcg numeric(7, 2) check (min_vitamin_a_mcg >= 0),
    add column if not exists min_vitamin_c_mg numeric(7, 2) check (min_vitamin_c_mg >= 0),
    add column if not exists min_vitamin_d_mcg numeric(7, 2) check (min_vitamin_d_mcg >= 0);

-- There is deliberately NO profiles column here, and no
-- `micronutrient_tracking_enabled`. Like caffeine, these need no opt-in: the
-- alcohol toggle exists for one specific harm (imported recipe exports carry
-- trace alcohol, and surfacing it is damaging to users in recovery) and no
-- micronutrient has an equivalent. Display is DATA-DRIVEN instead — a sodium
-- line appears once the user actually has sodium recorded, or once they set a
-- sodium target, and never otherwise.
