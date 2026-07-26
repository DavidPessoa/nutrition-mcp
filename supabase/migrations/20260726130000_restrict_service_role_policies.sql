-- Scope the permissive "Allow all for service role" policies to the role they
-- were named for.
--
-- These policies were created with no TO clause, so Postgres defaulted them to
-- PUBLIC — i.e. they applied to `anon` and `authenticated` too, both of which
-- hold full CRUD grants on every public table. The USING(true) qualifier meant
-- anyone holding the project's anon key (which is public by design and is not a
-- secret) could read, rewrite or delete every row in these tables: every user's
-- meal history, and every OAuth access/refresh token.
--
-- The server authenticates with SUPABASE_SECRET_KEY (src/supabase.ts) and no
-- anon or publishable key appears anywhere in this repo, so nothing legitimate
-- loses access. service_role additionally carries BYPASSRLS, so this is
-- belt-and-braces rather than load-bearing for the server.
--
-- Not touched: nutrition_goals, profiles, water_log and weight_log already
-- restrict by `auth.uid() = user_id`, which is a real qualifier. food_cache has
-- RLS enabled with zero policies, which already denies every non-bypassing role.
--
-- Applied to production 2026-07-26, ahead of the fiber/sugar/alcohol deploy.

alter policy "Allow all for service role" on public.meals to service_role;
alter policy "Allow all for service role" on public.tool_analytics to service_role;
alter policy "Allow all for service role" on public.oauth_tokens to service_role;
alter policy "Allow all for service role" on public.refresh_tokens to service_role;
alter policy "Allow all for service role" on public.auth_codes to service_role;
alter policy "Allow all for service role" on public.registered_clients to service_role;
