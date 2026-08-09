-- Caffeine tracking: a per-meal caffeine amount and its optional daily ceiling.
--
-- Every statement here is additive and every new column is nullable, so this is
-- safe to apply to the populated production tables: no existing row is
-- rewritten, no existing row is invalidated by the new checks (NULL passes a
-- check constraint), and every current write path keeps working unchanged
-- before the server that knows about these columns ships. The reverse order —
-- server first, migration second — is what breaks, so this lands first.

-- MILLIGRAMS ARE CANONICAL, and the column name says so.
--
-- This is the only nutrient column in `meals` whose unit differs from its
-- siblings' grams, which is exactly why the unit has to be carried in the name
-- at every layer (column, TS field, Zod key, CSV header, importer alias): a
-- bare `caffeine` header is how someone's 180 mg silently becomes 180 g.
--
-- mg is also what the world already uses: every label, every Open Food Facts
-- record and every guideline (EFSA's 400 mg/day, 200 mg single dose) is stated
-- in mg. A shot of espresso is 0.063 g, so storing grams would bury every real
-- value three decimals deep and make a numeric(6,2) goal column useless.
--
-- Bare `numeric` matches the existing per-meal nutrient columns. Nullable
-- because the overwhelming majority of logged meals carry no caffeine figure at
-- all — and NULL means "not recorded", never zero: read paths must never
-- average an unrecorded meal in as 0 mg.
alter table public.meals
    add column if not exists caffeine_mg numeric check (caffeine_mg >= 0);

-- Optional daily target, nullable so users can skip it. Zero is meaningful
-- here — a caffeine goal of 0 mg means "none", the same way an alcohol goal of
-- 0 g does — so the check allows it.
--
-- numeric(7, 2) rather than the numeric(6, 2) every gram target uses: mg values
-- run three orders of magnitude larger than gram ones, so the sibling precision
-- would cap a daily caffeine goal at 9999.99 — survivable today, but the extra
-- integer digit costs nothing and removes the question entirely.
alter table public.nutrition_goals
    add column if not exists daily_caffeine_mg numeric(7, 2) check (daily_caffeine_mg >= 0);

-- There is deliberately NO profiles column in this migration. Caffeine has no
-- opt-in flag and no `caffeine_tracking_enabled` twin of
-- `alcohol_tracking_enabled` — it was not forgotten.
--
-- That alcohol toggle exists for one specific harm: imported third-party recipe
-- exports carry trace alcohol, and surfacing it unbidden is actively damaging
-- to users in recovery. Caffeine has no equivalent, so it behaves like fiber and
-- sugar: always available, no extra tool pair, no profile state. Display
-- suppression is DATA-DRIVEN instead — the read paths render a caffeine line
-- only once the user actually has caffeine recorded, so no one is shown
-- "0 mg vs goal" for a nutrient they have never logged.
