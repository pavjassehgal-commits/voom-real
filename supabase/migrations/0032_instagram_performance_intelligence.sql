-- 0032_instagram_performance_intelligence.sql
--
-- Voom Performance Intelligence v1 — normalized performance snapshots for
-- content Voom itself published to Instagram.
--
-- STATUS: PREPARED FOR REVIEW. Do not apply without explicit approval.
--   Migrations 0001-0031 are untouched; nothing here re-runs or alters them.
--   This file is purely additive: one new table, its indexes, its trigger,
--   its RLS policy and its grants. No existing table, column, policy, grant
--   or row is modified or removed.
--
-- What this adds
--   public.instagram_performance_snapshots — ONE normalized measurement of ONE
--   already-published Instagram media item at ONE collection instant.
--
--   It is deliberately separate from public.instagram_insight_snapshots
--   (migration 0006): that table stores ACCOUNT-level insight blobs captured
--   from the browser-triggered read, keyed by (owner, media id, period_end),
--   and its metrics are provider-shaped. This table is the internal model MARA
--   reads: per-published-media, content-typed, timestamped, numeric-only.
--
-- Truthfulness rules encoded in the schema (not just in application code):
--   1. `instagram_media_id` is NOT NULL — a snapshot exists only for a real
--      Meta media id. Provider acceptance of a container is never enough.
--   2. `published_at` is NOT NULL — the real publish instant of that media.
--   3. `collected_at` is NOT NULL and part of the uniqueness key, so a
--      repeated sync is an idempotent refresh of the same collection window
--      instead of an unbounded duplicate stream.
--   4. Every value inside `metrics` must be a real, non-negative JSON number.
--      A missing metric is stored as an ABSENT KEY, never as 0 or null, so
--      "Meta did not expose reach" can never be misread as "reach was zero".
--
-- Owner isolation
--   RLS is enabled and the only client policy is SELECT-own. Authenticated
--   clients have no INSERT/UPDATE/DELETE privilege on this table at all; only
--   service_role (the server-side sync) writes snapshots.
--
-- Rollback:
--   drop policy if exists "instagram_performance_snapshots_select_own"
--     on public.instagram_performance_snapshots;
--   drop trigger if exists set_instagram_performance_snapshots_updated_at
--     on public.instagram_performance_snapshots;
--   drop table if exists public.instagram_performance_snapshots;

begin;

create table if not exists public.instagram_performance_snapshots (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  -- Which business's results these are. Additive association only: deleting a
  -- business never destroys measured history.
  business_id uuid references public.businesses (id) on delete set null,
  -- The content item Voom planned, approved, scheduled and published.
  draft_id uuid references public.mara_drafts (id) on delete set null,
  calendar_item_id uuid references public.content_calendar_items (id) on delete set null,
  publish_queue_id uuid,
  -- The real Meta media id returned by media_publish. Required by design.
  instagram_media_id text not null check (char_length(instagram_media_id) between 1 and 120),
  content_type text not null check (content_type in ('post', 'reel', 'story')),
  published_at timestamptz not null,
  -- The collection instant, bucketed by the sync to a fixed window (hourly),
  -- so re-running the sync inside the same window refreshes the same row.
  collected_at timestamptz not null,
  -- Normalized metrics: {"reach": 812, "likes": 44, ...}. Absent key = the
  -- provider did not expose that metric for this media/account.
  metrics jsonb not null default '{}'::jsonb,
  -- Where each stored metric came from: {"reach": "insights", "likes": "media_node"}.
  metric_sources jsonb not null default '{}'::jsonb,
  -- The provider's own media type/product type for this id, for support.
  provider_media_type text check (provider_media_type is null or char_length(provider_media_type) <= 40),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(metrics) = 'object'),
  check (jsonb_typeof(metric_sources) = 'object'),
  -- Numbers only, never negative. This is the schema-level "no fake metrics".
  check (not jsonb_path_exists(metrics, '$.* ? (@.type() != "number" || @ < 0)')),
  -- Idempotency: one row per (owner, media, collection window).
  unique (owner_user_id, instagram_media_id, collected_at),
  -- The snapshot can never outlive the queue row it measures, but a deleted
  -- queue row must not delete measured history, hence SET NULL.
  foreign key (publish_queue_id, owner_user_id)
    references public.instagram_publish_queue (id, owner_user_id) on delete set null
);

create index if not exists instagram_performance_owner_published_idx
  on public.instagram_performance_snapshots (owner_user_id, published_at desc);

create index if not exists instagram_performance_media_collected_idx
  on public.instagram_performance_snapshots (owner_user_id, instagram_media_id, collected_at desc);

drop trigger if exists set_instagram_performance_snapshots_updated_at on public.instagram_performance_snapshots;
create trigger set_instagram_performance_snapshots_updated_at
  before update on public.instagram_performance_snapshots
  for each row execute function public.set_updated_at();

alter table public.instagram_performance_snapshots enable row level security;

revoke all on table public.instagram_performance_snapshots from public, anon, authenticated;
-- Owners may READ their own measured results (the Performance page and Today
-- read through the session client, so RLS — not application code — is the
-- isolation boundary). Only service_role may write.
grant select on table public.instagram_performance_snapshots to authenticated;
grant select, insert, update, delete on table public.instagram_performance_snapshots to service_role;

drop policy if exists "instagram_performance_snapshots_select_own" on public.instagram_performance_snapshots;
create policy "instagram_performance_snapshots_select_own"
  on public.instagram_performance_snapshots
  for select
  to authenticated
  using ((select auth.uid()) = owner_user_id);

commit;
