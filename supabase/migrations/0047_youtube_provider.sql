-- 0047_youtube_provider.sql
--
-- REAL YOUTUBE PROVIDER INTEGRATION v1.
--
-- STATUS: PREPARED FOR REVIEW. DO NOT APPLY TO PRODUCTION without the
--   explicit rollout procedure (Google Cloud project, OAuth consent screen,
--   YouTube API Services Compliance Audit, encryption keys, cron entries).
--   Production migrations through 0046 are live; this file is the only new
--   one and it never re-runs anything from 0001-0046.
--
-- What this adds (ALL additive — nothing existing is renamed, retyped,
-- dropped or rewritten):
--
--   1. public.youtube_connections — sanitized connection metadata for ONE
--      YouTube channel per owner: the authoritative channel id/title/handle
--      YouTube itself returned, the granted scopes, truthful connection
--      status and the owner's explicit publishing defaults (privacy and
--      made-for-kids). No token bytes live in this table.
--   2. public.youtube_connection_secrets — the encrypted OAuth tokens
--      (refresh + latest access), service-role-only, mirroring the proven
--      instagram_connection_secrets pattern (0004/0007/0023). Encryption
--      happens in the application (AES-256-GCM, lib/youtube/crypto.ts);
--      the database only ever stores ciphertext, IV, auth tag, key version.
--   3. public.youtube_oauth_states — hashed, expiring, single-use OAuth
--      state values, mirroring instagram_oauth_states (0004).
--   4. public.youtube_publish_queue — ONE durable publish identity per
--      (owner, draft), mirroring instagram_publish_queue (0022): atomic
--      claiming with `for update skip locked`, a resumable-upload session
--      columns set, the provider's own evidence columns (video id, upload
--      status, actual privacy), and the same truthfulness guarantee:
--      `published` REQUIRES a real YouTube video id AND the provider's own
--      `processed` upload status AND published_at — provider acceptance of
--      bytes alone can never write that state.
--   5. public.youtube_performance_snapshots — normalized per-video metrics
--      from the YouTube Data API videos.list `statistics` part only, one row
--      per (owner, video, hourly collection window), mirroring 0032. No
--      YouTube Analytics (monetary) scope or metric exists anywhere here.
--   6. Security-definer RPCs for every sensitive mutation, granted to
--      service_role only, exactly like the Instagram integration.
--
-- Provider truths encoded in the schema:
--   - scheduled != submitted: a queue row is `scheduled` until a worker
--     claims it; nothing external has happened.
--   - submitted != provider accepted: bytes may be uploaded (`uploading`)
--     without any video existing yet.
--   - provider accepted != published: an upload that completed returns a
--     video id (`provider_processing`), but `published` additionally requires
--     YouTube's own processingDetails.uploadStatus = 'processed'.
--   - Google's unaudited-project restriction (videos.insert from projects
--     created after 2020-07-28 that have not passed the YouTube API
--     Compliance Audit are locked to private viewing mode) can never be
--     hidden: the queue stores the privacy status the PROVIDER actually
--     returned next to the one the owner requested, so Voom can say
--     "uploaded, but YouTube locked it to private" instead of claiming a
--     public publication that did not happen.
--
-- NOTHING here deletes data, drops a table or a column, retypes a column,
-- touches migrations 0001-0046, touches Instagram/Email/Multi-Social rows,
-- sends email, publishes anywhere, enqueues paid media, spends a credit,
-- changes a plan price or allowance, or schedules a cron. Historical Voom
-- records for a disconnected channel are preserved; NOTHING here can delete
-- a customer's YouTube video — no videos.delete call path exists in this
-- integration at all. RLS and service-role-only mutation boundaries follow
-- the existing Instagram pattern exactly.
--
-- Rollback:
--   drop function if exists public.list_youtube_published_for_verification(integer, timestamptz, interval);
--   drop function if exists public.claim_youtube_reconcile_jobs(integer, timestamptz, integer, interval);
--   drop function if exists public.record_youtube_provider_status(uuid, uuid, text, text, text, timestamptz);
--   drop function if exists public.complete_youtube_publish_job(uuid, uuid, text, text, text);
--   drop function if exists public.record_youtube_video_id(uuid, uuid, text, text, text);
--   drop function if exists public.record_youtube_upload_progress(uuid, uuid, bigint);
--   drop function if exists public.record_youtube_upload_session(uuid, uuid, text, bigint);
--   drop function if exists public.fail_youtube_publish_job(uuid, uuid, text, text, text, timestamptz, boolean);
--   drop function if exists public.claim_due_youtube_upload_jobs(integer, timestamptz, integer, interval);
--   drop function if exists public.cancel_youtube_publish_queue_item(uuid, uuid);
--   drop function if exists public.upsert_youtube_publish_queue_item(uuid, uuid, uuid, text, text, text, text, boolean, text, timestamptz, boolean);
--   drop trigger if exists youtube_publish_queue_terminal_guard on public.youtube_publish_queue;
--   drop function if exists public.youtube_publish_queue_guard();
--   drop function if exists public.set_youtube_publish_defaults(uuid, text, boolean);
--   drop function if exists public.set_youtube_connection_status(uuid, text);
--   drop function if exists public.update_youtube_access_token(uuid, text, text, text, smallint, timestamptz);
--   drop function if exists public.get_youtube_connection_secret(uuid);
--   drop function if exists public.disconnect_youtube_connection(uuid);
--   drop function if exists public.save_youtube_connection(uuid, text, text, text, text, text[], text, text, text, smallint, text, text, text, smallint, timestamptz);
--   drop policy if exists "youtube_performance_snapshots_select_own" on public.youtube_performance_snapshots;
--   drop policy if exists "youtube_publish_queue_select_own" on public.youtube_publish_queue;
--   drop policy if exists "youtube_connections_select_own" on public.youtube_connections;
--   drop table if exists public.youtube_performance_snapshots;
--   drop table if exists public.youtube_publish_queue;
--   drop table if exists public.youtube_oauth_states;
--   drop table if exists public.youtube_connection_secrets;
--   drop table if exists public.youtube_connections;

begin;

-- 1) The connection ----------------------------------------------------------

create table if not exists public.youtube_connections (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null unique references auth.users (id) on delete cascade,
  -- The authoritative channel identity YouTube itself returned from
  -- channels.list?mine=true. Never a guess, never user-typed.
  channel_id text not null check (char_length(channel_id) between 1 and 64),
  channel_title text check (channel_title is null or char_length(channel_title) <= 200),
  channel_handle text check (channel_handle is null or char_length(channel_handle) <= 100),
  thumbnail_url text check (thumbnail_url is null or char_length(thumbnail_url) <= 2048),
  -- The scopes Google actually granted at consent time.
  scopes text[] not null default '{}',
  status text not null default 'connected' check (status in (
    'connected', 'expired', 'revoked', 'error', 'disconnected'
  )),
  access_token_expires_at timestamptz,
  -- Owner-level explicit publishing defaults. NULL means "no default":
  -- Voom never silently guesses policy-sensitive settings, so a draft with
  -- no explicit declaration and no default is held in `needs_declaration`.
  default_privacy text check (default_privacy is null or default_privacy in ('public', 'private', 'unlisted')),
  default_made_for_kids boolean,
  last_synced_at timestamptz,
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_user_id)
);

-- One YouTube channel belongs to at most ONE connected Voom owner. A
-- disconnected row keeps its history (and its channel id) without blocking
-- anything: the partial index only constrains actively connected rows.
create unique index if not exists youtube_connections_channel_connected_uidx
  on public.youtube_connections (channel_id)
  where status = 'connected';

create table if not exists public.youtube_connection_secrets (
  connection_id uuid primary key references public.youtube_connections (id) on delete cascade,
  owner_user_id uuid not null unique references auth.users (id) on delete cascade,
  -- The long-lived OAuth refresh token, encrypted application-side.
  encrypted_refresh_token text not null,
  refresh_iv text not null,
  refresh_auth_tag text not null,
  refresh_key_version smallint not null default 2 check (refresh_key_version > 0),
  -- The most recent access token, encrypted, plus its expiry metadata.
  -- Nullable: an access token is derived (refreshed) server-side on demand.
  encrypted_access_token text,
  access_iv text,
  access_auth_tag text,
  access_key_version smallint check (access_key_version is null or access_key_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (connection_id, owner_user_id)
    references public.youtube_connections (id, owner_user_id) on delete cascade
);

create table if not exists public.youtube_oauth_states (
  state_hash text primary key,
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists youtube_connections_owner_idx on public.youtube_connections (owner_user_id);
create index if not exists youtube_oauth_states_owner_expiry_idx on public.youtube_oauth_states (owner_user_id, expires_at);

drop trigger if exists set_youtube_connections_updated_at on public.youtube_connections;
create trigger set_youtube_connections_updated_at before update on public.youtube_connections
  for each row execute function public.set_updated_at();
drop trigger if exists set_youtube_connection_secrets_updated_at on public.youtube_connection_secrets;
create trigger set_youtube_connection_secrets_updated_at before update on public.youtube_connection_secrets
  for each row execute function public.set_updated_at();

alter table public.youtube_connections enable row level security;
alter table public.youtube_connection_secrets enable row level security;
alter table public.youtube_oauth_states enable row level security;

-- Sanitized metadata is readable by its owner; secrets and OAuth state are
-- service-role-only (no grant to authenticated at all), exactly like the
-- Instagram integration.
revoke all on table public.youtube_connections, public.youtube_connection_secrets, public.youtube_oauth_states from public, anon, authenticated;
grant select on table public.youtube_connections to authenticated;

drop policy if exists "youtube_connections_select_own" on public.youtube_connections;
create policy "youtube_connections_select_own"
  on public.youtube_connections
  for select
  to authenticated
  using ((select auth.uid()) = owner_user_id);

-- 2) The publish queue --------------------------------------------------------

create table if not exists public.youtube_publish_queue (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  draft_id uuid not null,
  calendar_item_id uuid references public.content_calendar_items (id) on delete set null,
  -- Voom's canonical YouTube formats (lib/social/channels): a Short and a
  -- full Video are BOTH real videos.insert uploads — YouTube has no separate
  -- Shorts endpoint, and none is invented here.
  youtube_format text not null check (youtube_format in ('short', 'video')),
  -- The metadata YouTube's videos.insert requires, snapshotted at enqueue:
  -- title (max 100), description (max 5000), privacy, the COPPA audience
  -- declaration and the category. made_for_kids/privacy are NULLABLE: NULL
  -- means the owner has not explicitly declared them (and set no default),
  -- which parks the row in `needs_declaration` — Voom never guesses.
  title text not null check (char_length(title) between 1 and 100),
  description text not null default '' check (char_length(description) <= 5000),
  privacy_status text check (privacy_status is null or privacy_status in ('public', 'private', 'unlisted')),
  made_for_kids boolean,
  category_id text not null default '22' check (category_id ~ '^[0-9]{1,10}$'),
  scheduled_at timestamptz not null,
  status text not null default 'scheduled' check (status in (
    'scheduled',
    'waiting_for_media',
    'needs_declaration',
    'permission_required',
    'uploading',
    'provider_processing',
    'published',
    'failed',
    'cancelled'
  )),
  -- Durable publish identity. One per (owner, draft): see the unique below.
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 200),
  -- Resumable-upload session state. The session URL is persisted BEFORE any
  -- byte is sent, so an interrupted upload resumes instead of restarting —
  -- and a second session (a second video) is never created while one exists.
  upload_session_url text check (upload_session_url is null or char_length(upload_session_url) <= 2048),
  upload_content_length bigint check (upload_content_length is null or upload_content_length > 0),
  upload_bytes_sent bigint not null default 0 check (upload_bytes_sent >= 0),
  -- The provider's own evidence. youtube_video_id is ONLY ever written from
  -- a real videos.insert completion response or a real videos.list read.
  youtube_video_id text check (youtube_video_id is null or char_length(youtube_video_id) between 1 and 64),
  -- processingDetails.uploadStatus as YouTube itself reported it.
  provider_upload_status text check (provider_upload_status is null or provider_upload_status in (
    'uploaded', 'processed', 'rejected', 'failed', 'deleted'
  )),
  -- The privacy YouTube ACTUALLY applied (an unaudited API project locks
  -- every upload to private no matter what was requested — that fact is
  -- stored, never hidden).
  provider_privacy_status text check (provider_privacy_status is null or provider_privacy_status in ('public', 'private', 'unlisted')),
  provider_rejection_reason text check (provider_rejection_reason is null or char_length(provider_rejection_reason) <= 120),
  provider_note text check (provider_note is null or char_length(provider_note) <= 300),
  last_provider_check_at timestamptz,
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
  -- Truthfulness: a published row must carry the provider's own video id,
  -- provider evidence and a published_at instant. The ONLY writer of
  -- 'published' is complete_youtube_publish_job, which the database itself
  -- restricts to YouTube's uploadStatus = 'processed' — and the terminal
  -- guard below makes the state irreversible. provider_upload_status may
  -- later diverge ('deleted', a late rejection): reconciliation records what
  -- YouTube says NOW without rewriting the proven publication fact.
  constraint youtube_publish_queue_published_is_real
    check (status <> 'published' or (
      youtube_video_id is not null
      and provider_upload_status is not null
      and published_at is not null
    )),
  constraint youtube_publish_queue_published_at_requires_published
    check (published_at is null or status = 'published'),
  -- A video id only ever exists alongside provider evidence of processing.
  constraint youtube_publish_queue_video_id_has_status
    check (youtube_video_id is null or provider_upload_status is not null),
  foreign key (draft_id, owner_user_id)
    references public.mara_drafts (id, owner_user_id) on delete cascade
);

-- A real YouTube video id may be recorded only once, ever.
create unique index if not exists youtube_publish_queue_video_unique_idx
  on public.youtube_publish_queue (youtube_video_id)
  where youtube_video_id is not null;

-- Mirrors the upload-phase claim predicate exactly.
create index if not exists youtube_publish_queue_due_idx
  on public.youtube_publish_queue (scheduled_at)
  where status in ('scheduled', 'waiting_for_media');

-- The reconciliation phase scans by provider state, not by schedule.
create index if not exists youtube_publish_queue_provider_idx
  on public.youtube_publish_queue (status, last_attempt_at)
  where status in ('uploading', 'provider_processing');

create index if not exists youtube_publish_queue_owner_scheduled_idx
  on public.youtube_publish_queue (owner_user_id, scheduled_at desc);

drop trigger if exists set_youtube_publish_queue_updated_at on public.youtube_publish_queue;
create trigger set_youtube_publish_queue_updated_at
  before update on public.youtube_publish_queue
  for each row execute function public.set_updated_at();

-- Terminal guard: a published row's PROVEN FACTS are immutable. Bookkeeping
-- columns (provider status re-checks, notes, bytes sent) may still be
-- updated — reconciliation must be able to record that a video was later
-- deleted on YouTube without rewriting the truth that Voom published it.
create or replace function public.youtube_publish_queue_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    -- A proven publication is history: even a service-role maintenance script
    -- may not erase it (nothing in Voom deletes queue rows by design).
    if old.status = 'published' then
      raise exception 'youtube_publish_already_published';
    end if;
    return old;
  end if;
  if old.status = 'published' then
    if new.status <> 'published'
       or new.youtube_video_id is distinct from old.youtube_video_id
       or new.published_at is distinct from old.published_at then
      raise exception 'youtube_publish_already_published';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists youtube_publish_queue_terminal_guard on public.youtube_publish_queue;
create trigger youtube_publish_queue_terminal_guard
  before update or delete on public.youtube_publish_queue
  for each row execute function public.youtube_publish_queue_guard();

alter table public.youtube_publish_queue enable row level security;

revoke all on table public.youtube_publish_queue from public, anon, authenticated;
grant select on table public.youtube_publish_queue to authenticated;
grant select, insert, update, delete on table public.youtube_publish_queue to service_role;

drop policy if exists "youtube_publish_queue_select_own" on public.youtube_publish_queue;
create policy "youtube_publish_queue_select_own"
  on public.youtube_publish_queue
  for select
  to authenticated
  using ((select auth.uid()) = owner_user_id);

-- 3) Performance snapshots ----------------------------------------------------

create table if not exists public.youtube_performance_snapshots (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete set null,
  draft_id uuid references public.mara_drafts (id) on delete set null,
  calendar_item_id uuid references public.content_calendar_items (id) on delete set null,
  publish_queue_id uuid,
  -- The real YouTube video id. Required by design — no video, no snapshot.
  youtube_video_id text not null check (char_length(youtube_video_id) between 1 and 64),
  content_type text not null check (content_type in ('short', 'video')),
  published_at timestamptz not null,
  -- The collection instant, bucketed by the sync to a fixed hourly window,
  -- so re-running the sync inside the same window refreshes the same row.
  collected_at timestamptz not null,
  -- Normalized metrics from the Data API statistics part ONLY:
  -- {"views": 812, "likes": 44, "comments": 7}. Absent key = the provider
  -- did not return that number (unavailable != zero).
  metrics jsonb not null default '{}'::jsonb,
  metric_sources jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(metrics) = 'object'),
  check (jsonb_typeof(metric_sources) = 'object'),
  -- Numbers only, never negative. Schema-level "no fake metrics".
  check (not jsonb_path_exists(metrics, '$.* ? (@.type() != "number" || @ < 0)')),
  -- Idempotency: one row per (owner, video, collection window).
  unique (owner_user_id, youtube_video_id, collected_at),
  foreign key (publish_queue_id, owner_user_id)
    references public.youtube_publish_queue (id, owner_user_id) on delete set null
);

create index if not exists youtube_performance_owner_published_idx
  on public.youtube_performance_snapshots (owner_user_id, published_at desc);

alter table public.youtube_performance_snapshots enable row level security;

revoke all on table public.youtube_performance_snapshots from public, anon, authenticated;
grant select on table public.youtube_performance_snapshots to authenticated;
grant select, insert, update on table public.youtube_performance_snapshots to service_role;

drop policy if exists "youtube_performance_snapshots_select_own" on public.youtube_performance_snapshots;
create policy "youtube_performance_snapshots_select_own"
  on public.youtube_performance_snapshots
  for select
  to authenticated
  using ((select auth.uid()) = owner_user_id);

drop trigger if exists set_youtube_performance_snapshots_updated_at on public.youtube_performance_snapshots;
create trigger set_youtube_performance_snapshots_updated_at
  before update on public.youtube_performance_snapshots
  for each row execute function public.set_updated_at();

-- 4) Connection RPCs (service-role-only) ---------------------------------------

create or replace function public.save_youtube_connection(
  p_owner_user_id uuid,
  p_channel_id text,
  p_channel_title text,
  p_channel_handle text,
  p_thumbnail_url text,
  p_scopes text[],
  p_encrypted_refresh_token text,
  p_refresh_iv text,
  p_refresh_auth_tag text,
  p_refresh_key_version smallint,
  p_encrypted_access_token text,
  p_access_iv text,
  p_access_auth_tag text,
  p_access_key_version smallint,
  p_access_token_expires_at timestamptz
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  connection_uuid uuid;
begin
  if p_channel_id is null or char_length(p_channel_id) = 0 then
    raise exception 'youtube_channel_id_required';
  end if;
  if p_encrypted_refresh_token is null or char_length(p_encrypted_refresh_token) = 0 then
    raise exception 'youtube_refresh_token_required';
  end if;

  insert into public.youtube_connections (
    owner_user_id, channel_id, channel_title, channel_handle, thumbnail_url,
    scopes, status, access_token_expires_at, last_synced_at, connected_at, disconnected_at
  ) values (
    p_owner_user_id, p_channel_id, p_channel_title, p_channel_handle, p_thumbnail_url,
    coalesce(p_scopes, '{}'), 'connected', p_access_token_expires_at, now(), now(), null
  )
  on conflict (owner_user_id) do update set
    channel_id = excluded.channel_id,
    channel_title = excluded.channel_title,
    channel_handle = excluded.channel_handle,
    thumbnail_url = excluded.thumbnail_url,
    scopes = excluded.scopes,
    status = 'connected',
    access_token_expires_at = excluded.access_token_expires_at,
    last_synced_at = now(),
    connected_at = now(),
    disconnected_at = null
  returning id into connection_uuid;

  insert into public.youtube_connection_secrets (
    connection_id, owner_user_id, encrypted_refresh_token, refresh_iv, refresh_auth_tag,
    refresh_key_version, encrypted_access_token, access_iv, access_auth_tag, access_key_version
  ) values (
    connection_uuid, p_owner_user_id, p_encrypted_refresh_token, p_refresh_iv, p_refresh_auth_tag,
    coalesce(p_refresh_key_version, 2), p_encrypted_access_token, p_access_iv, p_access_auth_tag,
    p_access_key_version
  )
  on conflict (connection_id) do update set
    owner_user_id = excluded.owner_user_id,
    encrypted_refresh_token = excluded.encrypted_refresh_token,
    refresh_iv = excluded.refresh_iv,
    refresh_auth_tag = excluded.refresh_auth_tag,
    refresh_key_version = excluded.refresh_key_version,
    encrypted_access_token = excluded.encrypted_access_token,
    access_iv = excluded.access_iv,
    access_auth_tag = excluded.access_auth_tag,
    access_key_version = excluded.access_key_version;

  return connection_uuid;
end;
$$;

-- Local disconnect. Deletes the encrypted tokens (future publishing becomes
-- impossible), marks the connection disconnected and withdraws every row
-- that has NOT reached the provider yet. Rows with provider evidence
-- (uploading with a session, processing, published) are left for the
-- reconciliation worker and history: Voom NEVER deletes the customer's
-- YouTube videos — no such call exists anywhere in this integration.
create or replace function public.disconnect_youtube_connection(p_owner_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_count integer;
begin
  delete from public.youtube_connection_secrets where owner_user_id = p_owner_user_id;
  update public.youtube_connections
    set status = 'disconnected', disconnected_at = now(), access_token_expires_at = null
    where owner_user_id = p_owner_user_id;
  get diagnostics changed_count = row_count;

  update public.youtube_publish_queue
    set status = 'cancelled',
        claimed_at = null,
        failure_code = 'connection_disconnected',
        failure_message = 'The YouTube connection was removed before this item reached YouTube.'
    where owner_user_id = p_owner_user_id
      and status in ('scheduled', 'waiting_for_media', 'needs_declaration', 'permission_required');

  return changed_count > 0;
end;
$$;

-- Narrow service-role-only secret retrieval, mirroring 0007.
create or replace function public.get_youtube_connection_secret(p_owner_user_id uuid)
returns table (
  channel_id text,
  scopes text[],
  connection_status text,
  encrypted_refresh_token text,
  refresh_iv text,
  refresh_auth_tag text,
  encrypted_access_token text,
  access_iv text,
  access_auth_tag text,
  access_token_expires_at timestamptz
)
language sql
security definer
set search_path = ''
stable
as $$
  select c.channel_id, c.scopes, c.status,
    s.encrypted_refresh_token, s.refresh_iv, s.refresh_auth_tag,
    s.encrypted_access_token, s.access_iv, s.access_auth_tag,
    c.access_token_expires_at
  from public.youtube_connections c
  join public.youtube_connection_secrets s
    on s.connection_id = c.id and s.owner_user_id = c.owner_user_id
  where c.owner_user_id = p_owner_user_id
  limit 1;
$$;

-- Persists a freshly refreshed access token (ciphertext only).
create or replace function public.update_youtube_access_token(
  p_owner_user_id uuid,
  p_encrypted_access_token text,
  p_access_iv text,
  p_access_auth_tag text,
  p_access_key_version smallint,
  p_access_token_expires_at timestamptz
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_count integer;
begin
  update public.youtube_connection_secrets
    set encrypted_access_token = p_encrypted_access_token,
        access_iv = p_access_iv,
        access_auth_tag = p_access_auth_tag,
        access_key_version = coalesce(p_access_key_version, 2)
    where owner_user_id = p_owner_user_id;
  get diagnostics changed_count = row_count;
  if changed_count = 0 then
    return false;
  end if;

  update public.youtube_connections
    set access_token_expires_at = p_access_token_expires_at,
        last_synced_at = now()
    where owner_user_id = p_owner_user_id;
  return true;
end;
$$;

-- Truthful connection-state transitions (revoked authorization, refresh
-- failures). Never fabricates 'connected'; only workers that observed the
-- provider's own response call this.
create or replace function public.set_youtube_connection_status(
  p_owner_user_id uuid,
  p_status text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_count integer;
begin
  if p_status not in ('connected', 'expired', 'revoked', 'error', 'disconnected') then
    raise exception 'youtube_connection_status_invalid';
  end if;

  update public.youtube_connections
    set status = p_status,
        disconnected_at = case when p_status in ('disconnected', 'revoked') then now() else disconnected_at end,
        access_token_expires_at = case when p_status in ('disconnected', 'revoked') then null else access_token_expires_at end
    where owner_user_id = p_owner_user_id;
  get diagnostics changed_count = row_count;

  -- A revoked/expired authorization stops FUTURE publishing truthfully:
  -- rows that never reached the provider are failed with an actionable code.
  -- Provider-evidence rows are left for reconciliation and history.
  if p_status in ('revoked', 'expired', 'disconnected') then
    update public.youtube_publish_queue
      set status = 'permission_required',
          claimed_at = null,
          failure_code = 'authorization_revoked',
          failure_message = 'YouTube authorization is no longer valid. Reconnect the channel to resume publishing.'
      where owner_user_id = p_owner_user_id
        and status in ('scheduled', 'waiting_for_media', 'needs_declaration');
  end if;

  return changed_count > 0;
end;
$$;

-- Owner-level explicit defaults. Full-replacement semantics: NULL clears the
-- default, which puts undeclared drafts back into `needs_declaration`.
create or replace function public.set_youtube_publish_defaults(
  p_owner_user_id uuid,
  p_default_privacy text,
  p_default_made_for_kids boolean
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_count integer;
begin
  if p_default_privacy is not null and p_default_privacy not in ('public', 'private', 'unlisted') then
    raise exception 'youtube_default_privacy_invalid';
  end if;

  update public.youtube_connections
    set default_privacy = p_default_privacy,
        default_made_for_kids = p_default_made_for_kids
    where owner_user_id = p_owner_user_id;
  get diagnostics changed_count = row_count;
  return changed_count > 0;
end;
$$;

-- 5) Queue RPCs ----------------------------------------------------------------

-- Enqueue / reschedule one approved+scheduled YouTube draft. Idempotent: one
-- row per (owner, draft) forever. Published, uploading and processing rows
-- are left untouched — the provider already owns them. NULL privacy or
-- made-for-kids parks the row in `needs_declaration` (never a guess).
create or replace function public.upsert_youtube_publish_queue_item(
  p_owner_user_id uuid,
  p_draft_id uuid,
  p_calendar_item_id uuid,
  p_youtube_format text,
  p_title text,
  p_description text,
  p_privacy_status text,
  p_made_for_kids boolean,
  p_category_id text,
  p_scheduled_at timestamptz,
  p_waiting_for_media boolean default false
) returns public.youtube_publish_queue
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.youtube_publish_queue;
  v_status text;
begin
  if p_youtube_format not in ('short', 'video') then
    raise exception 'youtube_publish_format_invalid';
  end if;
  if p_title is null or char_length(trim(p_title)) = 0 or char_length(p_title) > 100 then
    raise exception 'youtube_publish_title_invalid';
  end if;
  if p_privacy_status is not null and p_privacy_status not in ('public', 'private', 'unlisted') then
    raise exception 'youtube_publish_privacy_invalid';
  end if;

  v_status := case
    when p_privacy_status is null or p_made_for_kids is null then 'needs_declaration'
    when p_waiting_for_media then 'waiting_for_media'
    else 'scheduled'
  end;

  select * into v_row from public.youtube_publish_queue
    where owner_user_id = p_owner_user_id and draft_id = p_draft_id
    for update;

  if not found then
    insert into public.youtube_publish_queue (
      owner_user_id, draft_id, calendar_item_id, youtube_format, title, description,
      privacy_status, made_for_kids, category_id, scheduled_at, status, idempotency_key
    ) values (
      p_owner_user_id, p_draft_id, p_calendar_item_id, p_youtube_format, p_title,
      left(coalesce(p_description, ''), 5000),
      p_privacy_status, p_made_for_kids, coalesce(p_category_id, '22'),
      p_scheduled_at, v_status,
      'ytpub_' || replace(p_draft_id::text, '-', '')
    )
    returning * into v_row;
    return v_row;
  end if;

  -- The provider already owns this row: nothing may rewrite it.
  if v_row.status in ('published', 'uploading', 'provider_processing') then
    return v_row;
  end if;

  update public.youtube_publish_queue set
    calendar_item_id = p_calendar_item_id,
    youtube_format = p_youtube_format,
    title = p_title,
    description = left(coalesce(p_description, ''), 5000),
    privacy_status = p_privacy_status,
    made_for_kids = p_made_for_kids,
    category_id = coalesce(p_category_id, '22'),
    scheduled_at = p_scheduled_at,
    status = v_status,
    failure_code = null,
    failure_message = null
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.cancel_youtube_publish_queue_item(
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
  update public.youtube_publish_queue
    set status = 'cancelled', claimed_at = null
    where owner_user_id = p_owner_user_id
      and draft_id = p_draft_id
      and status not in ('published', 'uploading', 'provider_processing');
  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

-- Upload-phase claim. `for update skip locked` plus the status transition
-- means two concurrent cron runs can never claim the same row — the
-- duplicate-upload guarantee starts here. needs_declaration and
-- permission_required rows are NEVER claimed: they need the owner, not a
-- retry. Stale `uploading` rows belong to the reconciliation claim below.
create or replace function public.claim_due_youtube_upload_jobs(
  p_limit integer default 5,
  p_now timestamptz default now(),
  p_max_attempts integer default 5,
  p_stale_after interval default interval '15 minutes'
) returns setof public.youtube_publish_queue
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with due as (
    select q.id
    from public.youtube_publish_queue q
    where q.youtube_video_id is null
      and q.attempts < p_max_attempts
      and q.scheduled_at <= p_now
      and (
        q.status = 'scheduled'
        or q.status = 'waiting_for_media'
        -- A failed retryable failure returns to 'scheduled' with a retry_at;
        -- a genuinely dead row stays 'failed' and is not claimable.
      )
    order by q.scheduled_at
    limit greatest(coalesce(p_limit, 5), 1)
    for update skip locked
  )
  update public.youtube_publish_queue q
    set status = 'uploading',
        claimed_at = p_now,
        last_attempt_at = p_now,
        attempts = q.attempts + 1
  from due
  where q.id = due.id
  returning q.*;
end;
$$;

-- Reconciliation claim: rows whose outcome the provider still owes Voom.
--   * `provider_processing` rows are polled (YouTube's own processing is
--     asynchronous and can take minutes to hours) WITHOUT consuming upload
--     attempts — waiting for the provider is not a failure.
--   * stale `uploading` rows (a worker died mid-upload) are resumed through
--     their persisted session; they DO consume an attempt.
create or replace function public.claim_youtube_reconcile_jobs(
  p_limit integer default 10,
  p_now timestamptz default now(),
  p_max_attempts integer default 5,
  p_stale_after interval default interval '15 minutes'
) returns setof public.youtube_publish_queue
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with due as (
    select q.id, q.status
    from public.youtube_publish_queue q
    where (
        q.status = 'provider_processing'
        and (q.claimed_at is null or q.claimed_at < p_now - interval '2 minutes')
      )
      or (
        q.status = 'uploading'
        and q.claimed_at is not null
        and q.claimed_at < p_now - p_stale_after
        and q.attempts < p_max_attempts
      )
    order by q.scheduled_at
    limit greatest(coalesce(p_limit, 10), 1)
    for update skip locked
  )
  update public.youtube_publish_queue q
    set claimed_at = p_now,
        last_attempt_at = case when due.status = 'uploading' then p_now else q.last_attempt_at end,
        attempts = case when due.status = 'uploading' then q.attempts + 1 else q.attempts end
  from due
  where q.id = due.id
  returning q.*;
end;
$$;

-- Resumable-session bookkeeping. Persisted BEFORE the first byte is sent, so
-- a crash resumes the SAME session instead of creating a second video.
create or replace function public.record_youtube_upload_session(
  p_id uuid,
  p_owner_user_id uuid,
  p_session_url text,
  p_content_length bigint
) returns public.youtube_publish_queue
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.youtube_publish_queue;
begin
  update public.youtube_publish_queue
    set upload_session_url = p_session_url,
        upload_content_length = p_content_length,
        upload_bytes_sent = 0
    where id = p_id and owner_user_id = p_owner_user_id
      and status <> 'published' and youtube_video_id is null
    returning * into v_row;
  if not found then
    select * into v_row from public.youtube_publish_queue
      where id = p_id and owner_user_id = p_owner_user_id;
  end if;
  return v_row;
end;
$$;

create or replace function public.record_youtube_upload_progress(
  p_id uuid,
  p_owner_user_id uuid,
  p_bytes_sent bigint
) returns public.youtube_publish_queue
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.youtube_publish_queue;
begin
  update public.youtube_publish_queue
    set upload_bytes_sent = greatest(p_bytes_sent, upload_bytes_sent)
    where id = p_id and owner_user_id = p_owner_user_id and status <> 'published'
    returning * into v_row;
  if not found then
    select * into v_row from public.youtube_publish_queue
      where id = p_id and owner_user_id = p_owner_user_id;
  end if;
  return v_row;
end;
$$;

-- The upload completed and YouTube returned a real video resource. This is
-- provider ACCEPTANCE, not publication: the row moves to
-- `provider_processing` and only complete_youtube_publish_job — with
-- YouTube's own 'processed' upload status — may ever write `published`.
create or replace function public.record_youtube_video_id(
  p_id uuid,
  p_owner_user_id uuid,
  p_youtube_video_id text,
  p_provider_upload_status text,
  p_provider_privacy_status text
) returns public.youtube_publish_queue
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.youtube_publish_queue;
begin
  if p_youtube_video_id is null or char_length(p_youtube_video_id) = 0 then
    raise exception 'youtube_video_id_required';
  end if;
  if p_provider_upload_status is null or p_provider_upload_status not in ('uploaded', 'processed', 'rejected', 'failed', 'deleted') then
    raise exception 'youtube_provider_upload_status_invalid';
  end if;

  select * into v_row from public.youtube_publish_queue
    where id = p_id and owner_user_id = p_owner_user_id for update;
  if not found then
    raise exception 'youtube_publish_job_not_found';
  end if;
  if v_row.status = 'published' then
    return v_row;
  end if;
  -- A DIFFERENT video id on a row that already has one is a programming
  -- error or a duplicate-upload symptom: refuse, never overwrite evidence.
  if v_row.youtube_video_id is not null and v_row.youtube_video_id <> p_youtube_video_id then
    raise exception 'youtube_video_id_conflict';
  end if;

  update public.youtube_publish_queue set
    youtube_video_id = p_youtube_video_id,
    provider_upload_status = p_provider_upload_status,
    provider_privacy_status = coalesce(p_provider_privacy_status, provider_privacy_status),
    status = 'provider_processing',
    scheduled_at = now(),
    claimed_at = null,
    failure_code = null,
    failure_message = null
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

-- Truthful completion. Requires YouTube's OWN evidence: a video id already
-- recorded on the row and uploadStatus = 'processed'. Re-running it for an
-- already-published row is a safe no-op. It also stamps the draft's
-- provider_ref — the Multi-Social Core column 0046 reserved for exactly
-- this: a provider's own publication reference, written ONLY from a real
-- provider confirmation.
create or replace function public.complete_youtube_publish_job(
  p_id uuid,
  p_owner_user_id uuid,
  p_provider_upload_status text,
  p_provider_privacy_status text,
  p_provider_note text
) returns public.youtube_publish_queue
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.youtube_publish_queue;
begin
  if p_provider_upload_status is distinct from 'processed' then
    raise exception 'youtube_publish_not_processed';
  end if;

  select * into v_row from public.youtube_publish_queue
    where id = p_id and owner_user_id = p_owner_user_id for update;
  if not found then
    raise exception 'youtube_publish_job_not_found';
  end if;
  if v_row.youtube_video_id is null then
    raise exception 'youtube_video_id_required';
  end if;
  if v_row.status = 'published' then
    return v_row;
  end if;

  update public.youtube_publish_queue set
    status = 'published',
    provider_upload_status = 'processed',
    provider_privacy_status = coalesce(p_provider_privacy_status, provider_privacy_status),
    provider_note = left(coalesce(p_provider_note, provider_note), 300),
    published_at = now(),
    claimed_at = null,
    failure_code = null,
    failure_message = null,
    last_provider_check_at = now()
  where id = v_row.id
  returning * into v_row;

  update public.mara_drafts
    set provider_ref = v_row.youtube_video_id
    where id = v_row.draft_id
      and owner_user_id = v_row.owner_user_id
      and (provider_ref is null or provider_ref = v_row.youtube_video_id);

  return v_row;
end;
$$;

-- Truthful failure. p_retry_at non-null returns the row to a claimable state
-- for a later attempt; p_reset_attempts keeps quota exhaustion (a daily
-- provider budget, not this item's fault) from burning the attempt cap.
create or replace function public.fail_youtube_publish_job(
  p_id uuid,
  p_owner_user_id uuid,
  p_failure_code text,
  p_failure_message text,
  p_status text default 'failed',
  p_retry_at timestamptz default null,
  p_reset_attempts boolean default false
) returns public.youtube_publish_queue
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.youtube_publish_queue;
begin
  if p_status not in ('failed', 'scheduled', 'permission_required', 'waiting_for_media', 'needs_declaration') then
    raise exception 'youtube_publish_failure_status_invalid';
  end if;

  select * into v_row from public.youtube_publish_queue
    where id = p_id and owner_user_id = p_owner_user_id for update;
  if not found then
    raise exception 'youtube_publish_job_not_found';
  end if;
  if v_row.status = 'published' then
    return v_row;
  end if;

  update public.youtube_publish_queue set
    status = p_status,
    scheduled_at = coalesce(p_retry_at, scheduled_at),
    claimed_at = null,
    attempts = case when p_reset_attempts then 0 else attempts end,
    failure_code = left(coalesce(p_failure_code, 'unknown'), 80),
    failure_message = left(coalesce(p_failure_message, ''), 400)
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

-- Provider bookkeeping that is legal even on a published row: reconciliation
-- re-checks the video and records what YouTube says NOW (deleted, re-privated,
-- rejected after the fact) without rewriting the proven publication fact.
create or replace function public.record_youtube_provider_status(
  p_id uuid,
  p_owner_user_id uuid,
  p_provider_upload_status text,
  p_provider_privacy_status text,
  p_provider_note text,
  p_last_provider_check_at timestamptz default now()
) returns public.youtube_publish_queue
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.youtube_publish_queue;
begin
  if p_provider_upload_status is not null and p_provider_upload_status not in ('uploaded', 'processed', 'rejected', 'failed', 'deleted') then
    raise exception 'youtube_provider_upload_status_invalid';
  end if;

  update public.youtube_publish_queue set
    provider_upload_status = coalesce(p_provider_upload_status, provider_upload_status),
    provider_privacy_status = coalesce(p_provider_privacy_status, provider_privacy_status),
    provider_note = left(coalesce(p_provider_note, provider_note), 300),
    last_provider_check_at = p_last_provider_check_at
  where id = p_id and owner_user_id = p_owner_user_id
  returning * into v_row;
  return v_row;
end;
$$;

-- Read-only listing of published rows whose provider evidence is due for a
-- periodic existence/privacy re-check. Locking is unnecessary: the writes it
-- feeds (record_youtube_provider_status) are guarded bookkeeping.
create or replace function public.list_youtube_published_for_verification(
  p_limit integer default 25,
  p_now timestamptz default now(),
  p_min_age interval default interval '24 hours'
) returns setof public.youtube_publish_queue
language sql
security definer
set search_path = ''
stable
as $$
  select q.*
  from public.youtube_publish_queue q
  where q.status = 'published'
    and q.youtube_video_id is not null
    and (q.last_provider_check_at is null or q.last_provider_check_at < p_now - p_min_age)
  order by q.last_provider_check_at nulls first, q.published_at
  limit greatest(coalesce(p_limit, 25), 1);
$$;

-- 6) Function grants: server-side only -----------------------------------------

revoke all on function public.save_youtube_connection(uuid, text, text, text, text, text[], text, text, text, smallint, text, text, text, smallint, timestamptz) from public, anon, authenticated;
revoke all on function public.disconnect_youtube_connection(uuid) from public, anon, authenticated;
revoke all on function public.get_youtube_connection_secret(uuid) from public, anon, authenticated;
revoke all on function public.update_youtube_access_token(uuid, text, text, text, smallint, timestamptz) from public, anon, authenticated;
revoke all on function public.set_youtube_connection_status(uuid, text) from public, anon, authenticated;
revoke all on function public.set_youtube_publish_defaults(uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.upsert_youtube_publish_queue_item(uuid, uuid, uuid, text, text, text, text, boolean, text, timestamptz, boolean) from public, anon, authenticated;
revoke all on function public.cancel_youtube_publish_queue_item(uuid, uuid) from public, anon, authenticated;
revoke all on function public.claim_due_youtube_upload_jobs(integer, timestamptz, integer, interval) from public, anon, authenticated;
revoke all on function public.claim_youtube_reconcile_jobs(integer, timestamptz, integer, interval) from public, anon, authenticated;
revoke all on function public.record_youtube_upload_session(uuid, uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.record_youtube_upload_progress(uuid, uuid, bigint) from public, anon, authenticated;
revoke all on function public.record_youtube_video_id(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.complete_youtube_publish_job(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.fail_youtube_publish_job(uuid, uuid, text, text, text, timestamptz, boolean) from public, anon, authenticated;
revoke all on function public.record_youtube_provider_status(uuid, uuid, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.list_youtube_published_for_verification(integer, timestamptz, interval) from public, anon, authenticated;
revoke all on function public.youtube_publish_queue_guard() from public, anon, authenticated;

grant execute on function public.save_youtube_connection(uuid, text, text, text, text, text[], text, text, text, smallint, text, text, text, smallint, timestamptz) to service_role;
grant execute on function public.disconnect_youtube_connection(uuid) to service_role;
grant execute on function public.get_youtube_connection_secret(uuid) to service_role;
grant execute on function public.update_youtube_access_token(uuid, text, text, text, smallint, timestamptz) to service_role;
grant execute on function public.set_youtube_connection_status(uuid, text) to service_role;
grant execute on function public.set_youtube_publish_defaults(uuid, text, boolean) to service_role;
grant execute on function public.upsert_youtube_publish_queue_item(uuid, uuid, uuid, text, text, text, text, boolean, text, timestamptz, boolean) to service_role;
grant execute on function public.cancel_youtube_publish_queue_item(uuid, uuid) to service_role;
grant execute on function public.claim_due_youtube_upload_jobs(integer, timestamptz, integer, interval) to service_role;
grant execute on function public.claim_youtube_reconcile_jobs(integer, timestamptz, integer, interval) to service_role;
grant execute on function public.record_youtube_upload_session(uuid, uuid, text, bigint) to service_role;
grant execute on function public.record_youtube_upload_progress(uuid, uuid, bigint) to service_role;
grant execute on function public.record_youtube_video_id(uuid, uuid, text, text, text) to service_role;
grant execute on function public.complete_youtube_publish_job(uuid, uuid, text, text, text) to service_role;
grant execute on function public.fail_youtube_publish_job(uuid, uuid, text, text, text, timestamptz, boolean) to service_role;
grant execute on function public.record_youtube_provider_status(uuid, uuid, text, text, text, timestamptz) to service_role;
grant execute on function public.list_youtube_published_for_verification(integer, timestamptz, interval) to service_role;

commit;
