-- Fiber, sugar and alcohol tracking: three more per-meal nutrients, their
-- optional daily targets, and the two profile settings alcohol needs.
--
-- Every statement here is additive and each new column is nullable or defaulted,
-- so this is safe to apply to the populated production tables: no existing row
-- is rewritten and no current write path breaks before the server ships.

-- Per-meal nutrients, all in grams and all optional — most logged meals will
-- never carry them. Bare `numeric` matches the existing macro columns.
--
-- `sugar_g` is TOTAL sugars (the Open Food Facts `sugars_100g` sense, including
-- the sugar naturally present in fruit and milk), never added sugar — that
-- cannot be inferred from a label, so we do not pretend to.
--
-- `alcohol_g` is pure ethanol. Grams are canonical because a "standard drink"
-- is not portable (a US drink is 14 g, a UK unit 7.893 g), so drinks are a
-- render-time concern — see src/alcohol.ts.
alter table public.meals
    add column if not exists fiber_g numeric check (fiber_g >= 0),
    add column if not exists sugar_g numeric check (sugar_g >= 0),
    add column if not exists alcohol_g numeric check (alcohol_g >= 0);

-- Optional daily targets, nullable so users can skip any of them. Unlike
-- target_weight_g, zero is meaningful here — an alcohol goal of 0 g means
-- "none" — so the checks allow it.
alter table public.nutrition_goals
    add column if not exists daily_fiber_g numeric(6, 2) check (daily_fiber_g >= 0),
    add column if not exists daily_sugar_g numeric(6, 2) check (daily_sugar_g >= 0),
    add column if not exists daily_alcohol_g numeric(6, 2) check (daily_alcohol_g >= 0);

-- Alcohol tracking is opt-in and defaults FALSE for everyone, including every
-- existing profile row. When it is off, alcohol passed explicitly is still
-- STORED (never silently drop user data) but is omitted from the text summaries
-- and the widget stat line: imported third-party exports carry trace alcohol
-- from recipes, and surfacing that unbidden is actively harmful to users in
-- recovery. Fiber and sugar have no such toggle — they are always shown.
alter table public.profiles
    add column if not exists alcohol_tracking_enabled boolean not null default false;

-- Preferred display unit for alcohol. Storage stays canonical grams of ethanol;
-- this only controls formatting ("2.0 US drinks" vs "3.5 UK units"). Nullable
-- with NO default, mirroring preferred_weight_unit: NULL means "never chosen",
-- and display paths fall back to US. Covered by the existing "Users manage
-- their own profile" RLS policy.
alter table public.profiles
    add column if not exists preferred_drink_unit text
        check (preferred_drink_unit is null or preferred_drink_unit in ('us', 'uk'));
