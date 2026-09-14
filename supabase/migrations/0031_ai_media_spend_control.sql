-- 0031_ai_media_spend_control.sql
--
-- Owner settings for AI media spend, plus the audited source of one paid
-- generation. Additive and owner/RLS safe: no table is created or dropped, no
-- existing row is rewritten, and no policy or grant is weakened.
--
--   1. public.businesses.allow_automatic_paid_media (default TRUE)
--      May MARA submit a paid media generation on a scheduled/automatic run?
--      TRUE preserves the shipped Assisted/Autopilot behaviour, so nothing
--      changes for an existing account until its owner turns it off. Manual is
--      never allowed automatic paid media regardless of this value.
--   2. public.businesses.monthly_media_budget_usd (default 25.00)
--      The monthly ceiling for automatic media spend, in USD. 25 is the
--      product default.
--   3. public.mara_media_generations.spend_source
--      'user_request' | 'assisted' | 'autopilot' — what caused one paid
--      generation. Nullable: rows written before this migration keep NULL and
--      are simply unclassified (the month's spend accounting still reads
--      their existing estimated_cost_usd column from migration 0008).
--
-- Budget accounting deliberately reuses the EXISTING
-- mara_media_generations.estimated_cost_usd column — no new spend table and no
-- new accounting column. The index below only makes the owner+month read cheap.
--
-- Deliberately NOT changed:
--   * the Instagram publishing pipeline, its queue, its worker or its cron
--     cadence — this migration touches no publishing object at all,
--   * RLS, policies and grants: `businesses` already grants select/insert/
--     update on the TABLE, so the two new columns are covered; the new
--     `spend_source` column is deliberately NOT added to the authenticated
--     column grant, because it is server-side audit metadata,
--   * the media bucket, its policies, or any existing generation row.
--
-- Rollback:
--   drop index if exists public.mara_media_owner_spend_month_idx;
--   alter table public.mara_media_generations drop column if exists spend_source;
--   alter table public.businesses drop column if exists monthly_media_budget_usd;
--   alter table public.businesses drop column if exists allow_automatic_paid_media;

begin;

-- 1) + 2) Owner settings. Both defaults preserve today's behaviour: automatic
-- generation stays on for Assisted/Autopilot until the owner changes it, and
-- the monthly budget starts at the product default of $25.
alter table public.businesses
  add column if not exists allow_automatic_paid_media boolean not null default true;

alter table public.businesses
  add column if not exists monthly_media_budget_usd numeric(10,2) not null default 25
  check (monthly_media_budget_usd >= 0);

-- 3) The audited source of one paid generation. Server-side only.
alter table public.mara_media_generations
  add column if not exists spend_source text
  check (spend_source is null or spend_source in ('user_request', 'assisted', 'autopilot'));

-- Cheap owner+month spend read for the gate (the accounting column already
-- exists from migration 0008).
create index if not exists mara_media_owner_spend_month_idx
  on public.mara_media_generations (owner_user_id, created_at)
  where estimated_cost_usd is not null;

commit;
