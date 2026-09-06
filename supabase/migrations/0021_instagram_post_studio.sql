-- Instagram Post Studio: the `instagram_post` draft kind plus one private,
-- owner-scoped visual asset per content draft.
--
-- STATUS: ALREADY APPLIED to the production Supabase database.
--   * Do NOT run this file again — it is checked in so the schema in Git
--     matches the schema production is already running.
--   * There is deliberately NO 0022 migration. Post Studio reuses this schema.
--   * Migrations 0018, 0019 and 0020 are untouched by this file.
--
-- AUTHORITATIVE PRODUCTION SHAPE of public.post_draft_assets:
--   id, owner_user_id, draft_id, storage_path, display_name, mime_type,
--   byte_size, origin, status, created_at, updated_at
--   THERE IS NO format COLUMN. Post 1:1 / 4:5 lives on mara_drafts.channel.
--   origin CHECK: origin in ('uploaded_asset','uploaded_existing')
--   status CHECK: status = 'uploaded'
--
-- What this file contains:
--   1. public.mara_drafts.kind gains 'instagram_post' (every previous kind,
--      including 'instagram_caption', stays valid).
--   2. public.post_draft_assets — one private visual per draft (Instagram Post
--      or Reel), owner-scoped, server-written.
--   3. Row level security: authenticated users may SELECT their own rows only.
--   4. A metadata-only SELECT grant for authenticated. storage_path is
--      deliberately EXCLUDED so private object paths never reach the browser;
--      previews are short-lived signed URLs minted server-side.
--   5. All writes are service_role only.
--
-- DROP POLICY note (the corrected form):
--   The valid PostgreSQL syntax is `drop policy ... on <table>`.
--   The form `drop policy ... on table <table>` is a syntax error and must
--   never be used. Every DROP POLICY below uses the corrected `on <table>`
--   form and is idempotent via `if exists`.
--
-- Rollback considerations:
--   drop policy if exists "post_draft_assets_select_own" on public.post_draft_assets;
--   drop table if exists public.post_draft_assets;
--   Then re-add the previous kind check without 'instagram_post'. Existing
--   instagram_post drafts must be migrated or deleted first or the narrower
--   check will fail.

begin;

-- 1) mara_drafts.kind gains 'instagram_post'. The constraint is dropped by
--    looking it up in pg_constraint so this works whatever PostgreSQL named it.
do $$
declare c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_attribute att
      on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
    where con.conrelid = 'public.mara_drafts'::regclass
      and con.contype = 'c'
      and att.attname = 'kind'
  loop
    execute format('alter table public.mara_drafts drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.mara_drafts
  add constraint mara_drafts_kind_check
  check (kind in (
    'instagram_caption',
    'instagram_post',
    'reel',
    'email',
    'sms',
    'campaign_plan',
    'weekly_calendar'
  ));

-- 2) One private visual per draft. Post Studio posts and imported Reels each
--    own at most one asset; replacing it swaps the row and the private object.
--    Production has no format column on this table.
create table if not exists public.post_draft_assets (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  draft_id uuid not null,
  storage_path text not null check (char_length(storage_path) between 20 and 500),
  display_name text not null check (char_length(display_name) between 1 and 180),
  mime_type text not null check (mime_type in ('image/jpeg','image/png','image/webp','video/mp4','video/quicktime')),
  byte_size bigint not null check (byte_size between 1 and 20971520),
  origin text not null default 'uploaded_asset'
    check (origin in ('uploaded_asset','uploaded_existing')),
  status text not null default 'uploaded' check (status = 'uploaded'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_user_id, draft_id),
  unique (owner_user_id, storage_path),
  foreign key (draft_id, owner_user_id)
    references public.mara_drafts (id, owner_user_id) on delete cascade
);

create index if not exists post_draft_assets_owner_created_idx
  on public.post_draft_assets (owner_user_id, created_at desc);

-- 3) Row level security.
alter table public.post_draft_assets enable row level security;

-- 4) Grants. authenticated gets metadata only — storage_path is NOT granted.
revoke all on table public.post_draft_assets from public, anon, authenticated;
grant select (
  id, draft_id, display_name, mime_type, byte_size, origin, status,
  created_at, updated_at
) on table public.post_draft_assets to authenticated;
grant select, insert, update, delete on table public.post_draft_assets to service_role;

-- Corrected DROP POLICY syntax: `on public.post_draft_assets`, never
-- `on table public.post_draft_assets`.
drop policy if exists "post_draft_assets_select_own"
  on public.post_draft_assets;

create policy "post_draft_assets_select_own"
  on public.post_draft_assets
  for select
  to authenticated
  using ((select auth.uid()) = owner_user_id);

drop trigger if exists set_post_draft_assets_updated_at on public.post_draft_assets;
create trigger set_post_draft_assets_updated_at
  before update on public.post_draft_assets
  for each row execute function public.set_updated_at();

-- 5) The shared private bucket keeps serving Post Studio visuals. It stays
--    private; previews are minted server-side as short-lived signed URLs.
update storage.buckets set public = false where id = 'mara-media';

commit;
