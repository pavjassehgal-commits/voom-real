-- 0022_instagram_auto_publishing.sql
--
-- Instagram scheduled auto-publishing V1.
--
-- STATUS: PREPARED FOR REVIEW. Do not apply without explicit approval.
--   Production migrations through 0021 are already live; this file is the only
--   new one and it never re-runs anything from 0001-0021.
--
-- What this adds:
--   1. public.instagram_publish_queue — one durable publish identity per
--      approved+scheduled Post Studio draft (Instagram Post or Reel).
--   2. A hard uniqueness guarantee: at most ONE queue row per (owner, draft),
--      so a draft can never be enqueued twice, and a published row can never
--      be re-published (published rows are terminal and guarded by a trigger).
--   3. Atomic claiming (claim_due_instagram_publish_jobs) using
--      `for update skip locked` so two concurrent cron runs, a retry, or a
--      redeployment can never claim the same row twice.
--   4. Truthful completion/failure functions. `published` REQUIRES a real
--      Instagram media id and a published_at timestamp — provider acceptance
--      alone can never write that state.
--   5. RLS: owners may read their own queue rows only. Every write is
--      service_role / security-definer only.
--
-- Rollback:
--   drop function if exists public.claim_due_instagram_publish_jobs(integer, timestamptz);
--   drop function if exists public.complete_instagram_publish_job(uuid, uuid, text, text);
--   drop function if exists public.fail_instagram_publish_job(uuid, uuid, text, text, text, timestamptz);
--   drop function if exists public.record_instagram_publish_container(uuid, uuid, text);
--   drop function if exists public.upsert_instagram_publish_queue_item(uuid, uuid, uuid, text, text, timestamptz);
--   drop function if exists public.cancel_instagram_publish_queue_item(uuid, uuid);
--   drop trigger if exists instagram_publish_queue_terminal_guard on public.instagram_publish_queue;
--   drop function if exists public.instagram_publish_queue_guard();
--   drop policy if exists "instagram_publish_queue_select_own" on public.instagram_publish_queue;
--   drop table if exists public.instagram_publish_queue;

begin;

-- 1) The queue --------------------------------------------------------------

create table if not exists public.instagram_publish_queue (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  draft_id uuid not null,
  calendar_item_id uuid references public.content_calendar_items (id) on delete set null,
  media_kind text not null check (media_kind in ('image', 'reel')),
  caption text not null default '' check (char_length(caption) <= 2200),
  scheduled_at timestamptz not null,
  status text not null default 'scheduled' check (status in (
    'scheduled',
    'waiting_for_media',
    'permission_required',
    'publishing',
    'published',
    'failed',
    'cancelled'
  )),
  -- Durable publish identity. One per (owner, draft): see the unique below.
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 200),
  container_id text check (container_id is null or char_length(container_id) <= 120),
  instagram_media_id text check (instagram_media_id is null or char_length(instagram_media_id) <= 120),
  attempts integer not null default 0 check (attempts between 0 and 25),
  last_attempt_at timestamptz,
  claimed_at timestamptz,
  failure_code text check (failure_code is null or char_length(failure_code) <= 80),
  failure_message text check (failure_message is null or char_length(failure_message) <= 400),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_user_id),
  unique (owner_user_id, draft_id),
  unique (owner_user_id, idempotency_key),
  -- Truthfulness: published is only legal with a real Instagram media id.
  constraint instagram_publish_queue_published_is_real
    check (status <> 'published' or (instagram_media_id is not null and published_at is not null)),
  constraint instagram_publish_queue_published_at_requires_published
    check (published_at is null or status = 'published'),
  foreign key (draft_id, owner_user_id)
    references public.mara_drafts (id, owner_user_id) on delete cascade
);

-- A published Instagram media id may be recorded only once, ever.
create unique index if not exists instagram_publish_queue_media_unique_idx
  on public.instagram_publish_queue (instagram_media_id)
  where instagram_media_id is not null;

create index if not exists instagram_publish_queue_due_idx
  on public.instagram_publish_queue (scheduled_at)
  where status in ('scheduled', 'publishing');

create index if not exists instagram_publish_queue_owner_scheduled_idx
  on public.instagram_publish_queue (owner_user_id, scheduled_at desc);

drop trigger if exists set_instagram_publish_queue_updated_at on public.instagram_publish_queue;
create trigger set_instagram_publish_queue_updated_at
  before update on public.instagram_publish_queue
  for each row execute function public.set_updated_at();

-- 2) Terminal guard: a published row is immutable except for bookkeeping.
create or replace function public.instagram_publish_queue_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'published' then
    if new.status <> 'published'
       or new.instagram_media_id is distinct from old.instagram_media_id
       or new.published_at is distinct from old.published_at then
      raise exception 'instagram_publish_already_published';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists instagram_publish_queue_terminal_guard on public.instagram_publish_queue;
create trigger instagram_publish_queue_terminal_guard
  before update on public.instagram_publish_queue
  for each row execute function public.instagram_publish_queue_guard();

-- 3) RLS + grants -----------------------------------------------------------

alter table public.instagram_publish_queue enable row level security;

revoke all on table public.instagram_publish_queue from public, anon, authenticated;
grant select on table public.instagram_publish_queue to authenticated;
grant select, insert, update, delete on table public.instagram_publish_queue to service_role;

drop policy if exists "instagram_publish_queue_select_own"
  on public.instagram_publish_queue;
create policy "instagram_publish_queue_select_own"
  on public.instagram_publish_queue
  for select
  to authenticated
  using ((select auth.uid()) = owner_user_id);

-- 4) Enqueue / reschedule ---------------------------------------------------
-- Reschedule is legal only while the item has NOT begun publishing. Once the
-- worker has claimed it, or it is published, editing the schedule is a no-op:
-- a published post is never republished because its schedule changed.
create or replace function public.upsert_instagram_publish_queue_item(
  p_owner_user_id uuid,
  p_draft_id uuid,
  p_calendar_item_id uuid,
  p_media_kind text,
  p_caption text,
  p_scheduled_at timestamptz
) returns public.instagram_publish_queue
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.instagram_publish_queue;
begin
  if p_media_kind not in ('image', 'reel') then
    raise exception 'instagram_publish_media_kind_invalid';
  end if;

  select * into v_row from public.instagram_publish_queue
    where owner_user_id = p_owner_user_id and draft_id = p_draft_id
    for update;

  if not found then
    insert into public.instagram_publish_queue (
      owner_user_id, draft_id, calendar_item_id, media_kind, caption, scheduled_at,
      status, idempotency_key
    ) values (
      p_owner_user_id, p_draft_id, p_calendar_item_id, p_media_kind,
      coalesce(p_caption, ''), p_scheduled_at, 'scheduled',
      'igpub_' || replace(p_draft_id::text, '-', '')
    )
    returning * into v_row;
    return v_row;
  end if;

  if v_row.status in ('published', 'publishing') then
    return v_row;
  end if;

  update public.instagram_publish_queue set
    calendar_item_id = p_calendar_item_id,
    media_kind = p_media_kind,
    caption = coalesce(p_caption, ''),
    scheduled_at = p_scheduled_at,
    status = 'scheduled',
    failure_code = null,
    failure_message = null,
    container_id = null
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

-- 5) Cancel (reject / unapprove / unschedule / delete) ----------------------
create or replace function public.cancel_instagram_publish_queue_item(
  p_owner_user_id uuid,
  p_draft_id uuid
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
begin
  update public.instagram_publish_queue
    set status = 'cancelled', container_id = null
    where owner_user_id = p_owner_user_id
      and draft_id = p_draft_id
      and status not in ('published', 'publishing');
  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

-- 6) Atomic claim -----------------------------------------------------------
-- `for update skip locked` plus the status transition means a second concurrent
-- worker sees zero rows for anything already claimed. A stale 'publishing' row
-- becomes reclaimable only after p_stale_after, and only if it never obtained
-- an Instagram media id.
create or replace function public.claim_due_instagram_publish_jobs(
  p_limit integer default 10,
  p_now timestamptz default now(),
  p_max_attempts integer default 5,
  p_stale_after interval default interval '15 minutes'
) returns setof public.instagram_publish_queue
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with due as (
    select q.id
    from public.instagram_publish_queue q
    where q.instagram_media_id is null
      and q.attempts < p_max_attempts
      and q.scheduled_at <= p_now
      and (
        q.status = 'scheduled'
        or (q.status = 'publishing' and q.claimed_at is not null and q.claimed_at < p_now - p_stale_after)
      )
    order by q.scheduled_at
    limit greatest(coalesce(p_limit, 10), 1)
    for update skip locked
  )
  update public.instagram_publish_queue q
    set status = 'publishing',
        claimed_at = p_now,
        last_attempt_at = p_now,
        attempts = q.attempts + 1
  from due
  where q.id = due.id
  returning q.*;
end;
$$;

-- 7) Truthful completion ----------------------------------------------------
-- Only ever called with a media id Meta confirmed. Re-running it for an
-- already-published row is a safe no-op.
create or replace function public.complete_instagram_publish_job(
  p_id uuid,
  p_owner_user_id uuid,
  p_instagram_media_id text,
  p_container_id text
) returns public.instagram_publish_queue
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.instagram_publish_queue;
begin
  if p_instagram_media_id is null or char_length(p_instagram_media_id) = 0 then
    raise exception 'instagram_publish_media_id_required';
  end if;

  select * into v_row from public.instagram_publish_queue
    where id = p_id and owner_user_id = p_owner_user_id for update;
  if not found then
    raise exception 'instagram_publish_job_not_found';
  end if;
  if v_row.status = 'published' then
    return v_row;
  end if;

  update public.instagram_publish_queue set
    status = 'published',
    instagram_media_id = p_instagram_media_id,
    container_id = coalesce(p_container_id, container_id),
    published_at = now(),
    claimed_at = null,
    failure_code = null,
    failure_message = null
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

-- 8) Truthful failure -------------------------------------------------------
-- p_retry_at non-null returns the item to 'scheduled' for a later attempt.
-- p_status lets the worker record actionable states such as
-- 'permission_required' or 'waiting_for_media' instead of a blunt failure.
create or replace function public.fail_instagram_publish_job(
  p_id uuid,
  p_owner_user_id uuid,
  p_failure_code text,
  p_failure_message text,
  p_status text default 'failed',
  p_retry_at timestamptz default null
) returns public.instagram_publish_queue
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.instagram_publish_queue;
begin
  if p_status not in ('failed', 'scheduled', 'permission_required', 'waiting_for_media') then
    raise exception 'instagram_publish_failure_status_invalid';
  end if;

  select * into v_row from public.instagram_publish_queue
    where id = p_id and owner_user_id = p_owner_user_id for update;
  if not found then
    raise exception 'instagram_publish_job_not_found';
  end if;
  if v_row.status = 'published' then
    return v_row;
  end if;

  update public.instagram_publish_queue set
    status = p_status,
    scheduled_at = coalesce(p_retry_at, scheduled_at),
    claimed_at = null,
    failure_code = left(coalesce(p_failure_code, 'unknown'), 80),
    failure_message = left(coalesce(p_failure_message, ''), 400)
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

-- 9) Container bookkeeping --------------------------------------------------
-- Persisted BEFORE publish is attempted, so an ambiguous network response is
-- resumed against the same container instead of creating a second post.
create or replace function public.record_instagram_publish_container(
  p_id uuid,
  p_owner_user_id uuid,
  p_container_id text
) returns public.instagram_publish_queue
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.instagram_publish_queue;
begin
  update public.instagram_publish_queue
    set container_id = p_container_id
    where id = p_id and owner_user_id = p_owner_user_id and status <> 'published'
    returning * into v_row;
  if not found then
    select * into v_row from public.instagram_publish_queue
      where id = p_id and owner_user_id = p_owner_user_id;
  end if;
  return v_row;
end;
$$;

-- 10) Function grants: server-side only -------------------------------------
revoke all on function public.upsert_instagram_publish_queue_item(uuid, uuid, uuid, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.cancel_instagram_publish_queue_item(uuid, uuid) from public, anon, authenticated;
revoke all on function public.claim_due_instagram_publish_jobs(integer, timestamptz, integer, interval) from public, anon, authenticated;
revoke all on function public.complete_instagram_publish_job(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.fail_instagram_publish_job(uuid, uuid, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.record_instagram_publish_container(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.instagram_publish_queue_guard() from public, anon, authenticated;

grant execute on function public.upsert_instagram_publish_queue_item(uuid, uuid, uuid, text, text, timestamptz) to service_role;
grant execute on function public.cancel_instagram_publish_queue_item(uuid, uuid) to service_role;
grant execute on function public.claim_due_instagram_publish_jobs(integer, timestamptz, integer, interval) to service_role;
grant execute on function public.complete_instagram_publish_job(uuid, uuid, text, text) to service_role;
grant execute on function public.fail_instagram_publish_job(uuid, uuid, text, text, text, timestamptz) to service_role;
grant execute on function public.record_instagram_publish_container(uuid, uuid, text) to service_role;

-- 11) The media bucket stays private. Meta receives short-lived signed URLs
--     minted server-side at publish time; nothing is ever made public.
update storage.buckets set public = false where id = 'mara-media';

commit;
