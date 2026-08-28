-- Real Instagram media, insight snapshots, and approval-gated publishing jobs.
-- Client roles may read only their own sanitized records. All writes are server-only.

begin;

create table if not exists public.instagram_media_assets (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  draft_id uuid references public.mara_drafts(id) on delete set null,
  storage_path text not null check (char_length(storage_path) between 1 and 1024),
  media_type text not null check (media_type in ('IMAGE','REELS','CAROUSEL_ITEM')),
  mime_type text not null check (mime_type in ('image/jpeg','image/png','video/mp4')),
  byte_size bigint not null check (byte_size > 0 and byte_size <= 104857600),
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  duration_seconds numeric check (duration_seconds is null or duration_seconds between 0 and 900),
  created_at timestamptz not null default now(),
  unique (id, owner_user_id),
  unique (owner_user_id, storage_path)
);

create table if not exists public.instagram_insight_snapshots (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  instagram_media_id text,
  period_start timestamptz not null,
  period_end timestamptz not null,
  metrics jsonb not null default '{}'::jsonb,
  captured_at timestamptz not null default now(),
  check (period_end >= period_start),
  unique (owner_user_id, instagram_media_id, period_end)
);

create table if not exists public.instagram_publish_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  calendar_item_id uuid references public.content_calendar_items(id) on delete set null,
  draft_id uuid references public.mara_drafts(id) on delete set null,
  media_asset_id uuid not null,
  caption text not null default '' check (char_length(caption) <= 2200),
  publish_at timestamptz not null,
  status text not null default 'pending_confirmation' check (status in ('pending_confirmation','scheduled','processing','published','failed','cancelled')),
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 200),
  instagram_container_id text,
  instagram_media_id text,
  attempt_count integer not null default 0 check (attempt_count between 0 and 8),
  last_error_code text check (last_error_code is null or char_length(last_error_code) <= 80),
  confirmed_at timestamptz,
  started_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_user_id),
  unique (owner_user_id, idempotency_key),
  foreign key (media_asset_id, owner_user_id) references public.instagram_media_assets(id, owner_user_id) on delete restrict
);

create index if not exists instagram_insights_owner_captured_idx on public.instagram_insight_snapshots(owner_user_id, captured_at desc);
create index if not exists instagram_publish_due_idx on public.instagram_publish_jobs(publish_at) where status = 'scheduled';

alter table public.instagram_media_assets enable row level security;
alter table public.instagram_insight_snapshots enable row level security;
alter table public.instagram_publish_jobs enable row level security;

revoke all on table public.instagram_media_assets, public.instagram_insight_snapshots, public.instagram_publish_jobs from public, anon, authenticated;
grant select on table public.instagram_media_assets, public.instagram_insight_snapshots, public.instagram_publish_jobs to authenticated;
grant select, insert, update, delete on table public.instagram_media_assets, public.instagram_insight_snapshots, public.instagram_publish_jobs to service_role;

create policy "instagram_media_assets_select_own" on public.instagram_media_assets for select to authenticated using ((select auth.uid()) = owner_user_id);
create policy "instagram_insight_snapshots_select_own" on public.instagram_insight_snapshots for select to authenticated using ((select auth.uid()) = owner_user_id);
create policy "instagram_publish_jobs_select_own" on public.instagram_publish_jobs for select to authenticated using ((select auth.uid()) = owner_user_id);

drop trigger if exists set_instagram_publish_jobs_updated_at on public.instagram_publish_jobs;
create trigger set_instagram_publish_jobs_updated_at before update on public.instagram_publish_jobs
  for each row execute function public.set_updated_at();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('instagram-media', 'instagram-media', false, 104857600, array['image/jpeg','image/png','video/mp4'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

commit;
