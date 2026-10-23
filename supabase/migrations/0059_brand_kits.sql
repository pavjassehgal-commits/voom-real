-- 0059_brand_kits.sql: Brand Kit v2 storage (slice 1).
--
-- One append-only table holds everything MARA knows about a brand beyond the
-- original onboarding columns on public.businesses: the structured answers,
-- the confirmed Brand Brief text and references to uploaded assets. Every
-- edit INSERTS a new version row for the owner; rows are never updated or
-- deleted by users, so the version list is the edit history.
--
-- public.businesses keeps being written as before (dual write): today's
-- planner, coordinator, campaigns and Post Studio read the core brand fields
-- from there, and the brand kit only ADDS context (brief, offerings, rules,
-- facts, notes, voice samples) on top. Nothing existing changes shape.
--
-- Also registers the private `brand-kit` storage bucket (logo, product photos,
-- reference posts; images only, 10 MB each). Uploads go through server code
-- with the service role, like `mara-media`, so no storage.objects policy is
-- needed for users.

begin;

create table if not exists public.brand_kits (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  version integer not null check (version >= 1),
  -- Structured answers keyed by the Brand Kit field map (docs/brand-kit-v2-design.md).
  answers jsonb not null default '{}'::jsonb check (jsonb_typeof(answers) = 'object'),
  -- The confirmed Brand Brief paragraphs, plain text.
  brief text check (brief is null or char_length(brief) <= 6000),
  -- References to uploaded assets or imported posts; never file bytes.
  assets jsonb not null default '[]'::jsonb check (jsonb_typeof(assets) = 'array'),
  source text not null check (source in ('onboarding', 'brand_hub', 'extraction')),
  change_summary text check (change_summary is null or char_length(change_summary) <= 300),
  changed_keys text[] not null default '{}'::text[],
  created_at timestamptz not null default now(),
  unique (owner_user_id, version)
);

create index if not exists brand_kits_owner_version_idx
  on public.brand_kits(owner_user_id, version desc);

alter table public.brand_kits enable row level security;
revoke all on table public.brand_kits from public, anon, authenticated;
-- Users may read and append their own versions. No update or delete grant:
-- history is immutable for everyone except server code.
grant select, insert on table public.brand_kits to authenticated;
grant select, insert, update, delete on table public.brand_kits to service_role;

drop policy if exists "brand_kits_select_own" on public.brand_kits;
create policy "brand_kits_select_own" on public.brand_kits
  for select to authenticated using ((select auth.uid()) = owner_user_id);

drop policy if exists "brand_kits_insert_own" on public.brand_kits;
create policy "brand_kits_insert_own" on public.brand_kits
  for insert to authenticated with check ((select auth.uid()) = owner_user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'brand-kit',
  'brand-kit',
  false,
  10485760,
  array['image/jpeg','image/png','image/webp']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

commit;
