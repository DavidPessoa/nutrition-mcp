-- profiles.timezone could not represent "never chosen": it was NOT NULL
-- DEFAULT 'UTC', so any upsertProfile call that doesn't touch timezone (the
-- set_weight_unit / set_widget_display / set_alcohol_tracking tools all do
-- this) silently created a row that then read as "the user chose UTC"
-- forever after, permanently defeating the "timezone unset, read as UTC"
-- warning on every write and import path (#99, follow-up from #68).
--
-- Made nullable. NULL now means "never explicitly set with set_timezone";
-- every reader coalesces to 'UTC' at read time (getUserTimezone already
-- did), and "configured" call sites now check `timezone !== null` instead
-- of `profile !== null`.
--
-- Existing rows are ambiguous — a stored 'UTC' could be a deliberate choice
-- or just the old default — and backfilling by created_at/updated_at is not
-- sound. The honest answer is to treat every pre-migration row as unset,
-- accepting one redundant set_timezone prompt for users who genuinely chose
-- UTC.
alter table public.profiles alter column timezone drop not null;
alter table public.profiles alter column timezone drop default;
update public.profiles set timezone = null;
