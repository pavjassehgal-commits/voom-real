-- Provider-independent MARA image/video generation and private asset storage.
-- Authenticated users may read only their own sanitized jobs. All writes are server-only.

begin;

create table if not exists public.mara_media_generations (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null,
  message_id uuid references public.mara_messages(id) on delete set null,
  draft_id uuid references public.mara_drafts(id) on delete set null,
  media_type text not null check (media_type in ('image','video')),
  prompt text not null check (char_length(prompt) between 1 and 4000),
  aspect_ratio text not null check (aspect_ratio in ('1:1','4:5','9:16','16:9')),
  status text not null default 'queued' check (status in ('pending_confirmation','queued','processing','completed','failed','cancelled')),
  approval_status text not null default 'draft' check (approval_status in ('draft','approved','rejected')),
  provider text,
  provider_job_id text,
  storage_path text,
  mime_type text check (mime_type is null or mime_type in ('image/jpeg','image/png','image/webp','video/mp4')),
  byte_size bigint check (byte_size is null or byte_size between 1 and 524288000),
  estimated_cost_usd numeric(10,4) check (estimated_cost_usd is null or estimated_cost_usd >= 0),
  duration_seconds integer check (duration_seconds is null or duration_seconds between 1 and 30),
  error_code text check (error_code is null or char_length(error_code) <= 80),
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (id, owner_user_id),
  unique (owner_user_id, idempotency_key),
  foreign key (conversation_id, owner_user_id)
    references public.mara_conversations(id, owner_user_id) on delete cascade
);

create index if not exists mara_media_owner_created_idx
  on public.mara_media_generations(owner_user_id, created_at desc);
create index if not exists mara_media_processing_idx
  on public.mara_media_generations(status, updated_at)
  where status in ('queued','processing');

alter table public.mara_media_generations enable row level security;
revoke all on table public.mara_media_generations from public, anon, authenticated;
grant select (
  id, conversation_id, message_id, draft_id, media_type, prompt, aspect_ratio,
  status, approval_status, mime_type, estimated_cost_usd, duration_seconds,
  created_at, updated_at, completed_at
) on table public.mara_media_generations to authenticated;
grant select, insert, update, delete on table public.mara_media_generations to service_role;

drop policy if exists "mara_media_select_own" on public.mara_media_generations;
create policy "mara_media_select_own" on public.mara_media_generations
  for select to authenticated using ((select auth.uid()) = owner_user_id);

drop trigger if exists set_mara_media_generations_updated_at on public.mara_media_generations;
create trigger set_mara_media_generations_updated_at
  before update on public.mara_media_generations
  for each row execute function public.set_updated_at();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'mara-media',
  'mara-media',
  false,
  524288000,
  array['image/jpeg','image/png','image/webp','video/mp4']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

commit;
