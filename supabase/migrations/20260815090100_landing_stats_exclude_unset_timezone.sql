-- profiles.timezone can now be NULL ("never chosen" — see
-- 20260815090000_nullable_profile_timezone.sql). json_object_agg raises
-- "null value not allowed for object key" on a NULL key, and grouping by a
-- nullable column produces exactly that once any profile has no timezone
-- set, which after that migration's backfill is every profile. Exclude
-- unset profiles from the per-timezone breakdown and the list;
-- count(distinct timezone) already ignores NULLs on its own.
create or replace function public.public_landing_stats()
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object(
    'food_logs',      (select count(*) from public.meals),
    'total_calories', (select coalesce(sum(calories), 0) from public.meals),
    'total_protein_g',(select coalesce(sum(protein_g), 0) from public.meals),
    'total_carbs_g',  (select coalesce(sum(carbs_g), 0) from public.meals),
    'total_fat_g',    (select coalesce(sum(fat_g), 0) from public.meals),
    'timezones',      (select count(distinct timezone) from public.profiles),
    'timezone_list',  (select coalesce(json_agg(distinct timezone), '[]'::json) from public.profiles where timezone is not null),
    -- json_object_agg over zero rows yields NULL, not '{}', hence the coalesce.
    'timezone_counts',(
      select coalesce(json_object_agg(timezone, n), '{}'::json)
      from (
        select timezone, count(*)::int as n
        from public.profiles
        where timezone is not null
        group by timezone
      ) per_tz
    )
  );
$$;

comment on function public.public_landing_stats() is
  'Aggregate-only stats for the public landing page. Exposes no per-user rows.';

-- Only the server (service-role) calls this; it never needs to be reachable
-- directly via the anon/authenticated PostgREST roles.
revoke execute on function public.public_landing_stats() from public;
grant execute on function public.public_landing_stats() to service_role;
