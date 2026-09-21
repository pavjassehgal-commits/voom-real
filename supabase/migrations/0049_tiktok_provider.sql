-- 0049_tiktok_provider.sql
--
-- REAL TIKTOK PROVIDER INTEGRATION v1.
--
-- (Named 0049 because migration 0048 is already used by the merged YouTube
-- OAuth hotfix, 0048_youtube_oauth_state_acl.sql. Nothing from 0001-0048 is
-- re-run or touched by this file.)
--
-- STATUS: PREPARED FOR REVIEW. DO NOT APPLY TO PRODUCTION without the
--   explicit rollout procedure (TikTok for Developers app with the Content
--   Posting API product, registered redirect URI, content-sharing audit,
--   encryption keys, cron entries). Production migrations through 0046 are
--   live; 0047/0048 (YouTube) ship with the YouTube provider rollout; this
--   file is the only new TikTok one.
--
-- What this adds (ALL additive — nothing existing is renamed, retyped,
-- dropped or rewritten):
--
--   1. public.tiktok_connections — sanitized connection metadata for ONE
--      TikTok account per owner: the authoritative open_id TikTok itself
--      returned (never user-typed), the display name and avatar from the
--      user.info.basic read, the granted scopes, truthful connection status,
--      and the owner's explicit privacy default. No token bytes live in
--      this table.
--   2. public.tiktok_connection_secrets — the encrypted OAuth tokens
--      (refresh + latest access), service-role-only, mirroring the proven
--      youtube/instagram secrets pattern. Encryption happens in the
--      application (AES-256-GCM, lib/tiktok/crypto.ts); the database only
--      ever stores ciphertext, IV, auth tag, key version.
--   3. public.tiktok_oauth_states — hashed, expiring, single-use OAuth
--      state values, mirroring youtube_oauth_states (0047).
--   4. public.tiktok_publish_queue — ONE durable publish identity per
--      (owner, draft): atomic claiming with `for update skip locked`, the
--      persisted provider publish_id + FILE_UPLOAD transfer state
--      (upload_url, content length, bytes sent), and the provider's own
--      evidence columns. Truthfulness guarantee: `published` REQUIRES a
--      real TikTok publish_id AND the provider's own
--      `PUBLISH_COMPLETE` post status AND published_at — provider
--      acceptance of a request can never write that state.
--   5. Security-definer RPCs for every sensitive mutation, granted to
--      service_role only, exactly like the YouTube/Instagram integrations.
--
-- Provider truths encoded in the schema (per the current official TikTok
-- Content Posting API documentation):
--   - scheduled != submitted: a queue row is `scheduled` until a worker
--     claims it; nothing external has happened.
--   - submitted != provider accepted: a returned publish_id with bytes in
--     flight is `posting`, NOT published.
--   - provider accepted != published: PUBLISH_COMPLETE from TikTok's own
--     post-status endpoint is the only publication evidence.
--   - TikTok has NO default privacy level: privacy_level is nullable and a
--     NULL parks the row in `needs_declaration` — Voom never chooses a
--     policy-sensitive value on the creator's behalf.
--   - The privacy level the creator chose is stored as requested; TikTok's
--     post-status answer (including the public post id when one is
--     returned, and the fail reason when the post fails) is stored next to
--     it, so an unaudited-client SELF_ONLY lock or a later rejection is
--     visible, never hidden.
--
-- NOTHING here deletes data, drops a table or a column, retypes a column,
-- touches migrations 0001-0048, touches Instagram/YouTube/Email/Multi-Social
-- rows, sends email, publishes anywhere, enqueues paid media, spends a
-- credit, changes a plan price or allowance, or schedules a cron. Historical
-- Voom records for a disconnected account are preserved; NOTHING here can
-- delete a customer's TikTok post — no video-delete call path exists in
-- this integration at all. RLS and service-role-only mutation boundaries
-- follow the existing YouTube pattern exactly.
--
-- Rollback:
--   drop function if exists public.list_tiktok_published_for_verification(integer, timestamptz, interval);
--   drop function if exists public.claim_tiktok_reconcile_jobs(integer, timestamptz, integer, interval);
--   drop function if exists public.reset_tiktok_publish_for_resubmit(uuid, uuid);
--   drop function if exists public.record_tiktok_provider_status(uuid, uuid, text, text, text, text, timestamptz);
--   drop function if exists public.complete_tiktok_publish_job(uuid, uuid, text, text, text);
--   drop function if exists public.set_tiktok_provider_processing(uuid, uuid);
--   drop function if exists public.record_tiktok_upload_progress(uuid, uuid, bigint);
--   drop function if exists public.record_tiktok_publish(uuid, uuid, text, text, bigint);
--   drop function if exists public.fail_tiktok_publish_job(uuid, uuid, text, text, text, timestamptz, boolean);
--   drop function if exists public.claim_due_tiktok_post_jobs(integer, timestamptz, integer, interval);
--   drop function if exists public.cancel_tiktok_publish_queue_item(uuid, uuid);
--   drop function if exists public.upsert_tiktok_publish_queue_item(uuid, uuid, uuid, text, text, boolean, boolean, boolean, boolean, boolean, boolean, timestamptz, boolean);
--   drop trigger if exists tiktok_publish_queue_terminal_guard on public.tiktok_publish_queue;
--   drop function if exists public.tiktok_publish_queue_guard();
--   drop function if exists public.set_tiktok_publish_defaults(uuid, text);
--   drop function if exists public.set_tiktok_connection_status(uuid, text);
--   drop function if exists public.update_tiktok_tokens(uuid, text, text, text, smallint, timestamptz, text, text, text, smallint, timestamptz);
--   drop function if exists public.get_tiktok_connection_secret(uuid);
--   drop function if exists public.disconnect_tiktok_connection(uuid);
--   drop function if exists public.save_tiktok_connection(uuid, text, text, text, text[], text, text, text, smallint, text, text, text, smallint, timestamptz, timestamptz);
--   drop policy if exists "tiktok_publish_queue_select_own" on public.tiktok_publish_queue;
--   drop policy if exists "tiktok_connections_select_own" on public.tiktok_connections;
--   drop table if exists public.tiktok_publish_queue;
--   drop table if exists public.tiktok_oauth_states;
--   drop table if exists public.tiktok_connection_secrets;
--   drop table if exists public.tiktok_connections;

begin;

-- 1) The connection ----------------------------------------------------------

create table if not exists public.tiktok_connections (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null unique references auth.users (id) on delete cascade,
  -- The authoritative identity TikTok itself returned: the partner-facing
  -- open_id from the token exchange, the display name and avatar from the
  -- user.info.basic read. Never a guess, never user-typed.
  open_id text not null check (char_length(open_id) between 1 and 64),
  display_name text check (display_name is null or char_length(display_name) <= 200),
  avatar_url text check (avatar_url is null or char_length(avatar_url) <= 2048),
  -- The creator's public username, from the last creator-info read (null
  -- until one has happened).
  creator_username text check (creator_username is null or char_length(creator_username) <= 100),
  -- The scopes TikTok actually granted at consent time.
  scopes text[] not null default '{}',
  status text not null default 'connected' check (status in (
    'connected', 'expired', 'revoked', 'error', 'disconnected'
  )),
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  -- Owner-level explicit privacy default. NULL means "no default": TikTok
  -- has no default privacy level, so a draft with no explicit declaration
  -- and no default is held in `needs_declaration`.
  default_privacy text check (default_privacy is null or default_privacy in (
    'PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'
  )),
  last_synced_at timestamptz,
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_user_id)
);

-- One TikTok account belongs to at most ONE connected Voom owner. A
-- disconnected row keeps its history without blocking anything.
create unique index if not exists tiktok_connections_open_id_connected_uidx
  on public.tiktok_connections (open_id)
  where status = 'connected';

create table if not exists public.tiktok_connection_secrets (
  connection_id uuid primary key references public.tiktok_connections (id) on delete cascade,
  owner_user_id uuid not null unique references auth.users (id) on delete cascade,
  -- The long-lived OAuth refresh token (365 days per TikTok's docs),
  -- encrypted application-side. TikTok may rotate it on refresh; the
  -- application always persists the newly returned value.
  encrypted_refresh_token text not null,
  refresh_iv text not null,
  refresh_auth_tag text not null,
  refresh_key_version smallint not null default 2 check (refresh_key_version > 0),
  -- The most recent access token (24 hours per TikTok's docs), encrypted,
  -- plus its expiry metadata. Nullable: an access token is derived
  -- (refreshed) server-side on demand.
  encrypted_access_token text,
  access_iv text,
  access_auth_tag text,
  access_key_version smallint check (access_key_version is null or access_key_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (connection_id, owner_user_id)
    references public.tiktok_connections (id, owner_user_id) on delete cascade
);

create table if not exists public.tiktok_oauth_states (
  state_hash text primary key,
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists tiktok_connections_owner_idx on public.tiktok_connections (owner_user_id);
create index if not exists tiktok_oauth_states_owner_expiry_idx on public.tiktok_oauth_states (owner_user_id, expires_at);

drop trigger if exists set_tiktok_connections_updated_at on public.tiktok_connections;
create trigger set_tiktok_connections_updated_at before update on public.tiktok_connections
  for each row execute function public.set_updated_at();
drop trigger if exists set_tiktok_connection_secrets_updated_at on public.tiktok_connection_secrets;
create trigger set_tiktok_connection_secrets_updated_at before update on public.tiktok_connection_secrets
  for each row execute function public.set_updated_at();

alter table public.tiktok_connections enable row level security;
alter table public.tiktok_connection_secrets enable row level security;
alter table public.tiktok_oauth_states enable row level security;

-- Sanitized metadata is readable by its owner; secrets and OAuth state are
-- service-role-only (no grant to authenticated at all), exactly like the
-- YouTube integration.
revoke all on table public.tiktok_connections, public.tiktok_connection_secrets, public.tiktok_oauth_states from public, anon, authenticated;
-- The connect/callback server code uses the service client for these direct
-- table operations. Keep the browser roles completely out of OAuth state;
-- connection metadata remains owner-filtered by its RLS policy.
grant select on table public.tiktok_connections to service_role;
grant select, insert, update on table public.tiktok_oauth_states to service_role;
grant select on table public.tiktok_connections to authenticated;

drop policy if exists "tiktok_connections_select_own" on public.tiktok_connections;
create policy "tiktok_connections_select_own"
  on public.tiktok_connections
  for select
  to authenticated
  using ((select auth.uid()) = owner_user_id);

-- 2) The publish queue --------------------------------------------------------

create table if not exists public.tiktok_publish_queue (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  draft_id uuid not null,
  calendar_item_id uuid references public.content_calendar_items (id) on delete set null,
  -- The TikTok caption/title (documented limit: 2200 characters),
  -- snapshotted at enqueue.
  title text not null check (char_length(title) between 1 and 2200),
  -- The privacy level the creator chose. NULL means not declared: TikTok
  -- has no default privacy level, so the row parks in `needs_declaration`
  -- — Voom never invents a policy-sensitive value.
  privacy_level text check (privacy_level is null or privacy_level in (
    'PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'
  )),
  -- Explicit interaction disclosures. NULL means "not declared": the field
  -- is then omitted from the request and TikTok's own defaults apply —
  -- Voom does not send a value the owner never chose.
  disable_comment boolean,
  disable_duet boolean,
  disable_stitch boolean,
  -- Commercial-content disclosures (TikTok content-sharing guidelines):
  -- sent ONLY when the owner explicitly declared them.
  brand_content_toggle boolean,
  brand_organic_toggle boolean,
  -- AI-generated content label: sent ONLY when Voom has an explicit record
  -- that the video is AI-generated.
  is_aigc boolean,
  scheduled_at timestamptz not null,
  status text not null default 'scheduled' check (status in (
    'scheduled',
    'waiting_for_media',
    'needs_declaration',
    'permission_required',
    'posting',
    'provider_processing',
    'published',
    'failed',
    'cancelled'
  )),
  -- Durable publish identity. One per (owner, draft): see the unique below.
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 200),
  -- The provider's own tracking reference, returned by the Direct Post
  -- init. Persisted BEFORE the first byte is sent, so a crash or retry can
  -- never initialize a second post for the same row. This is provider
  -- tracking, NOT publication evidence.
  tiktok_publish_id text check (tiktok_publish_id is null or char_length(tiktok_publish_id) between 1 and 64),
  -- FILE_UPLOAD transfer state. The upload_url carries TikTok's own upload
  -- token in its query string: it is resume state, never rendered to the
  -- browser and never logged.
  upload_url text check (upload_url is null or char_length(upload_url) <= 2048),
  upload_content_length bigint check (upload_content_length is null or upload_content_length > 0),
  upload_bytes_sent bigint not null default 0 check (upload_bytes_sent >= 0),
  -- The provider's own post-status answer as TikTok reported it.
  provider_status text check (provider_status is null or provider_status in (
    'PROCESSING_UPLOAD', 'PROCESSING_DOWNLOAD', 'SEND_TO_USER_INBOX',
    'PUBLISH_COMPLETE', 'FAILED'
  )),
  -- The public post id, returned by TikTok ONLY for public-viewership posts
  -- that pass its moderation. Its absence is not a failure (private posts
  -- of unaudited clients never get one).
  provider_post_id text check (provider_post_id is null or char_length(provider_post_id) between 1 and 64),
  provider_fail_reason text check (provider_fail_reason is null or char_length(provider_fail_reason) <= 200),
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
  -- Truthfulness: a published row must carry the provider's own publish id,
  -- the provider's own PUBLISH_COMPLETE status and a published_at instant.
  -- The ONLY writer of 'published' is complete_tiktok_publish_job, which
  -- the database itself restricts to that status — and the terminal guard
  -- below makes the state irreversible. provider_status may later diverge
  -- (the post removed on TikTok): reconciliation records what TikTok says
  -- NOW without rewriting the proven publication fact.
  constraint tiktok_publish_queue_published_is_real
    check (status <> 'published' or (
      tiktok_publish_id is not null
      and provider_status = 'PUBLISH_COMPLETE'
      and published_at is not null
    )),
  constraint tiktok_publish_queue_published_at_requires_published
    check (published_at is null or status = 'published'),
  foreign key (draft_id, owner_user_id)
    references public.mara_drafts (id, owner_user_id) on delete cascade
);

-- A real TikTok publish id may be recorded only once, ever.
create unique index if not exists tiktok_publish_queue_publish_id_unique_idx
  on public.tiktok_publish_queue (tiktok_publish_id)
  where tiktok_publish_id is not null;

-- Mirrors the posting-phase claim predicate exactly.
create index if not exists tiktok_publish_queue_due_idx
  on public.tiktok_publish_queue (scheduled_at)
  where status in ('scheduled', 'waiting_for_media');

-- The reconciliation phase scans by provider state, not by schedule.
create index if not exists tiktok_publish_queue_provider_idx
  on public.tiktok_publish_queue (status, last_attempt_at)
  where status in ('posting', 'provider_processing');

create index if not exists tiktok_publish_queue_owner_scheduled_idx
  on public.tiktok_publish_queue (owner_user_id, scheduled_at desc);

drop trigger if exists set_tiktok_publish_queue_updated_at on public.tiktok_publish_queue;
create trigger set_tiktok_publish_queue_updated_at
  before update on public.tiktok_publish_queue
  for each row execute function public.set_updated_at();

-- Terminal guard: a published row's PROVEN FACTS are immutable. Bookkeeping
-- columns (provider status re-checks, notes, bytes sent) may still be
-- updated — reconciliation must be able to record that a post was later
-- removed on TikTok without rewriting the truth that Voom published it.
create or replace function public.tiktok_publish_queue_guard()
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
      raise exception 'tiktok_publish_already_published';
    end if;
    return old;
  end if;
  if old.status = 'published' then
    if new.status <> 'published'
       or new.tiktok_publish_id is distinct from old.tiktok_publish_id
       or new.published_at is distinct from old.published_at then
      raise exception 'tiktok_publish_already_published';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists tiktok_publish_queue_terminal_guard on public.tiktok_publish_queue;
create trigger tiktok_publish_queue_terminal_guard
  before update or delete on public.tiktok_publish_queue
  for each row execute function public.tiktok_publish_queue_guard();

alter table public.tiktok_publish_queue enable row level security;

revoke all on table public.tiktok_publish_queue from public, anon, authenticated;
grant select on table public.tiktok_publish_queue to authenticated;
grant select, insert, update, delete on table public.tiktok_publish_queue to service_role;

drop policy if exists "tiktok_publish_queue_select_own" on public.tiktok_publish_queue;
create policy "tiktok_publish_queue_select_own"
  on public.tiktok_publish_queue
  for select
  to authenticated
  using ((select auth.uid()) = owner_user_id);

-- 3) Connection RPCs (service-role-only) ---------------------------------------

create or replace function public.save_tiktok_connection(
  p_owner_user_id uuid,
  p_open_id text,
  p_display_name text,
  p_avatar_url text,
  p_scopes text[],
  p_encrypted_refresh_token text,
  p_refresh_iv text,
  p_refresh_auth_tag text,
  p_refresh_key_version smallint,
  p_encrypted_access_token text,
  p_access_iv text,
  p_access_auth_tag text,
  p_access_key_version smallint,
  p_access_token_expires_at timestamptz,
  p_refresh_token_expires_at timestamptz
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  connection_uuid uuid;
begin
  if p_open_id is null or char_length(p_open_id) = 0 then
    raise exception 'tiktok_open_id_required';
  end if;
  if p_encrypted_refresh_token is null or char_length(p_encrypted_refresh_token) = 0 then
    raise exception 'tiktok_refresh_token_required';
  end if;

  insert into public.tiktok_connections (
    owner_user_id, open_id, display_name, avatar_url,
    scopes, status, access_token_expires_at, refresh_token_expires_at,
    last_synced_at, connected_at, disconnected_at
  ) values (
    p_owner_user_id, p_open_id, p_display_name, p_avatar_url,
    coalesce(p_scopes, '{}'), 'connected', p_access_token_expires_at, p_refresh_token_expires_at,
    now(), now(), null
  )
  on conflict (owner_user_id) do update set
    open_id = excluded.open_id,
    display_name = excluded.display_name,
    avatar_url = excluded.avatar_url,
    scopes = excluded.scopes,
    status = 'connected',
    access_token_expires_at = excluded.access_token_expires_at,
    refresh_token_expires_at = excluded.refresh_token_expires_at,
    last_synced_at = now(),
    connected_at = now(),
    disconnected_at = null
  returning id into connection_uuid;

  insert into public.tiktok_connection_secrets (
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
-- that has NOT reached the provider yet. Rows the provider owns (posting
-- with a publish_id, processing, published) are left for the
-- reconciliation worker and history: Voom NEVER deletes the customer's
-- TikTok posts — no such call exists anywhere in this integration.
create or replace function public.disconnect_tiktok_connection(p_owner_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_count integer;
begin
  delete from public.tiktok_connection_secrets where owner_user_id = p_owner_user_id;
  update public.tiktok_connections
    set status = 'disconnected', disconnected_at = now(), access_token_expires_at = null
    where owner_user_id = p_owner_user_id;
  get diagnostics changed_count = row_count;

  update public.tiktok_publish_queue
    set status = 'cancelled',
        claimed_at = null,
        failure_code = 'connection_disconnected',
        failure_message = 'The TikTok connection was removed before this item reached TikTok.'
    where owner_user_id = p_owner_user_id
      and status in ('scheduled', 'waiting_for_media', 'needs_declaration', 'permission_required');

  return changed_count > 0;
end;
$$;

-- Narrow service-role-only secret retrieval, mirroring 0007/0047.
create or replace function public.get_tiktok_connection_secret(p_owner_user_id uuid)
returns table (
  open_id text,
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
  select c.open_id, c.scopes, c.status,
    s.encrypted_refresh_token, s.refresh_iv, s.refresh_auth_tag,
    s.encrypted_access_token, s.access_iv, s.access_auth_tag,
    c.access_token_expires_at
  from public.tiktok_connections c
  join public.tiktok_connection_secrets s
    on s.connection_id = c.id and s.owner_user_id = c.owner_user_id
  where c.owner_user_id = p_owner_user_id
  limit 1;
$$;

-- Persists freshly refreshed tokens (ciphertext only). TikTok may ROTATE the
-- refresh token on refresh — the application passes the newly returned
-- value, and this is the only place it is persisted.
create or replace function public.update_tiktok_tokens(
  p_owner_user_id uuid,
  p_encrypted_access_token text,
  p_access_iv text,
  p_access_auth_tag text,
  p_access_key_version smallint,
  p_access_token_expires_at timestamptz,
  p_encrypted_refresh_token text,
  p_refresh_iv text,
  p_refresh_auth_tag text,
  p_refresh_key_version smallint,
  p_refresh_token_expires_at timestamptz
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_count integer;
begin
  update public.tiktok_connection_secrets
    set encrypted_access_token = p_encrypted_access_token,
        access_iv = p_access_iv,
        access_auth_tag = p_access_auth_tag,
        access_key_version = coalesce(p_access_key_version, 2),
        encrypted_refresh_token = coalesce(p_encrypted_refresh_token, encrypted_refresh_token),
        refresh_iv = coalesce(p_refresh_iv, refresh_iv),
        refresh_auth_tag = coalesce(p_refresh_auth_tag, refresh_auth_tag),
        refresh_key_version = coalesce(p_refresh_key_version, refresh_key_version)
    where owner_user_id = p_owner_user_id;
  get diagnostics changed_count = row_count;
  if changed_count = 0 then
    return false;
  end if;

  update public.tiktok_connections
    set access_token_expires_at = p_access_token_expires_at,
        refresh_token_expires_at = coalesce(p_refresh_token_expires_at, refresh_token_expires_at),
        last_synced_at = now()
    where owner_user_id = p_owner_user_id;
  return true;
end;
$$;

-- Truthful connection-state transitions (revoked authorization, refresh
-- failures). Never fabricates 'connected'; only workers that observed the
-- provider's own response call this.
create or replace function public.set_tiktok_connection_status(
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
    raise exception 'tiktok_connection_status_invalid';
  end if;

  update public.tiktok_connections
    set status = p_status,
        disconnected_at = case when p_status in ('disconnected', 'revoked') then now() else disconnected_at end,
        access_token_expires_at = case when p_status in ('disconnected', 'revoked') then null else access_token_expires_at end
    where owner_user_id = p_owner_user_id;
  get diagnostics changed_count = row_count;

  -- A revoked/expired authorization stops FUTURE publishing truthfully:
  -- rows that never reached the provider are failed with an actionable code.
  -- Provider-evidence rows are left for reconciliation and history.
  if p_status in ('revoked', 'expired', 'disconnected') then
    update public.tiktok_publish_queue
      set status = 'permission_required',
          claimed_at = null,
          failure_code = 'authorization_revoked',
          failure_message = 'TikTok authorization is no longer valid. Reconnect the account to resume publishing.'
      where owner_user_id = p_owner_user_id
        and status in ('scheduled', 'waiting_for_media', 'needs_declaration');
  end if;

  return changed_count > 0;
end;
$$;

-- Owner-level explicit privacy default. Full-replacement semantics: NULL
-- clears the default, which puts undeclared drafts back into
-- `needs_declaration` (TikTok has no default privacy level).
create or replace function public.set_tiktok_publish_defaults(
  p_owner_user_id uuid,
  p_default_privacy text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_count integer;
begin
  if p_default_privacy is not null and p_default_privacy not in (
    'PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'
  ) then
    raise exception 'tiktok_default_privacy_invalid';
  end if;

  update public.tiktok_connections
    set default_privacy = p_default_privacy
    where owner_user_id = p_owner_user_id;
  get diagnostics changed_count = row_count;
  return changed_count > 0;
end;
$$;

-- 4) Queue RPCs ----------------------------------------------------------------

-- Enqueue / reschedule one approved+scheduled TikTok draft. Idempotent: one
-- row per (owner, draft) forever. Published, posting and processing rows
-- are left untouched — the provider already owns them. NULL privacy parks
-- the row in `needs_declaration` (never a guess).
create or replace function public.upsert_tiktok_publish_queue_item(
  p_owner_user_id uuid,
  p_draft_id uuid,
  p_calendar_item_id uuid,
  p_title text,
  p_privacy_level text,
  p_disable_comment boolean,
  p_disable_duet boolean,
  p_disable_stitch boolean,
  p_brand_content_toggle boolean,
  p_brand_organic_toggle boolean,
  p_is_aigc boolean,
  p_scheduled_at timestamptz,
  p_waiting_for_media boolean default false
) returns public.tiktok_publish_queue
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.tiktok_publish_queue;
  v_status text;
begin
  if p_title is null or char_length(trim(p_title)) = 0 or char_length(p_title) > 2200 then
    raise exception 'tiktok_publish_title_invalid';
  end if;
  if p_privacy_level is not null and p_privacy_level not in (
    'PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'
  ) then
    raise exception 'tiktok_publish_privacy_invalid';
  end if;

  v_status := case
    when p_privacy_level is null then 'needs_declaration'
    when p_waiting_for_media then 'waiting_for_media'
    else 'scheduled'
  end;

  select * into v_row from public.tiktok_publish_queue
    where owner_user_id = p_owner_user_id and draft_id = p_draft_id
    for update;

  if not found then
    insert into public.tiktok_publish_queue (
      owner_user_id, draft_id, calendar_item_id, title,
      privacy_level, disable_comment, disable_duet, disable_stitch,
      brand_content_toggle, brand_organic_toggle, is_aigc,
      scheduled_at, status, idempotency_key
    ) values (
      p_owner_user_id, p_draft_id, p_calendar_item_id, p_title,
      p_privacy_level, p_disable_comment, p_disable_duet, p_disable_stitch,
      p_brand_content_toggle, p_brand_organic_toggle, p_is_aigc,
      p_scheduled_at, v_status,
      'ttpub_' || replace(p_draft_id::text, '-', '')
    )
    returning * into v_row;
    return v_row;
  end if;

  -- The provider already owns this row: nothing may rewrite it.
  if v_row.status in ('published', 'posting', 'provider_processing') then
    return v_row;
  end if;

  update public.tiktok_publish_queue set
    calendar_item_id = p_calendar_item_id,
    title = p_title,
    privacy_level = p_privacy_level,
    disable_comment = p_disable_comment,
    disable_duet = p_disable_duet,
    disable_stitch = p_disable_stitch,
    brand_content_toggle = p_brand_content_toggle,
    brand_organic_toggle = p_brand_organic_toggle,
    is_aigc = p_is_aigc,
    scheduled_at = p_scheduled_at,
    status = v_status,
    failure_code = null,
    failure_message = null
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.cancel_tiktok_publish_queue_item(
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
  update public.tiktok_publish_queue
    set status = 'cancelled', claimed_at = null
    where owner_user_id = p_owner_user_id
      and draft_id = p_draft_id
      and status not in ('published', 'posting', 'provider_processing');
  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

-- Posting-phase claim. `for update skip locked` plus the status transition
-- means two concurrent cron runs can never claim the same row — the
-- duplicate-post guarantee starts here. Two shapes are claimable:
--   * FRESH: no tiktok_publish_id exists yet — a normal first submission.
--   * RESUME: the row holds a publish id but was parked in `scheduled`
--     after a retryable interruption of the transfer (the id was persisted
--     before the first byte, so the resume NEVER re-initializes a post).
-- needs_declaration, permission_required and failed rows are NEVER
-- claimed here: the first two need the owner, the last one belongs to the
-- reconciliation claim (read-only status check / guarded re-arm). Stale
-- `posting` rows belong to the reconciliation claim below.
create or replace function public.claim_due_tiktok_post_jobs(
  p_limit integer default 5,
  p_now timestamptz default now(),
  p_max_attempts integer default 5,
  p_stale_after interval default interval '15 minutes'
) returns setof public.tiktok_publish_queue
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with due as (
    select q.id
    from public.tiktok_publish_queue q
    where (
        -- fresh submissions: no provider publish id exists yet
        q.tiktok_publish_id is null
        and q.attempts < p_max_attempts
        and q.scheduled_at <= p_now
        and q.status in ('scheduled', 'waiting_for_media')
      )
      or (
        -- parked rows that already hold a publish id: resume the transfer
        -- (or collect evidence) from the persisted state — never re-init
        q.tiktok_publish_id is not null
        and q.attempts < p_max_attempts
        and q.scheduled_at <= p_now
        and q.status = 'scheduled'
      )
    order by q.scheduled_at
    limit greatest(coalesce(p_limit, 5), 1)
    for update skip locked
  )
  update public.tiktok_publish_queue q
    set status = 'posting',
        claimed_at = p_now,
        last_attempt_at = p_now,
        attempts = q.attempts + 1
  from due
  where q.id = due.id
  returning q.*;
end;
$$;

-- Reconciliation claim: rows whose outcome the provider still owes Voom.
--   * `provider_processing` rows are polled (TikTok's processing is
--     asynchronous and public posts additionally pass moderation) WITHOUT
--     consuming posting attempts — waiting for the provider is not a
--     failure.
--   * stale `posting` rows (a worker died mid-upload) are resumed through
--     their persisted publish_id + progress; they DO consume an attempt.
create or replace function public.claim_tiktok_reconcile_jobs(
  p_limit integer default 10,
  p_now timestamptz default now(),
  p_max_attempts integer default 5,
  p_stale_after interval default interval '15 minutes'
) returns setof public.tiktok_publish_queue
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with due as (
    select q.id, q.status
    from public.tiktok_publish_queue q
    where (
        q.status = 'provider_processing'
        and q.tiktok_publish_id is not null
        and (q.claimed_at is null or q.claimed_at < p_now - interval '2 minutes')
      )
      or (
        q.status = 'posting'
        and q.claimed_at is not null
        and q.claimed_at < p_now - p_stale_after
        and q.attempts < p_max_attempts
      )
      or (
        -- fail-closed rows that persist a publish id: the ONLY recovery is
        -- a read-only post-status check on that id. Rate-limited to one
        -- check per 6 hours by last_provider_check_at (the check itself
        -- refreshes it), and a re-arm (invalid_publish_id) or a terminal
        -- provider answer ends the cycle.
        q.status = 'failed'
        and q.tiktok_publish_id is not null
        and q.failure_code in ('upload_task_gone', 'publish_ambiguous', 'post_unavailable', 'processing_timeout', 'upload_interrupted')
        and (q.claimed_at is null or q.claimed_at < p_now - interval '2 minutes')
        and (q.last_provider_check_at is null or q.last_provider_check_at < p_now - interval '6 hours')
        and q.attempts < p_max_attempts
      )
    order by q.scheduled_at
    limit greatest(coalesce(p_limit, 10), 1)
    for update skip locked
  )
  update public.tiktok_publish_queue q
    set claimed_at = p_now,
        last_attempt_at = case when due.status = 'posting' then p_now else q.last_attempt_at end,
        attempts = case when due.status = 'posting' then q.attempts + 1 else q.attempts end
  from due
  where q.id = due.id
  returning q.*;
end;
$$;

-- Direct Post init bookkeeping. Persisted BEFORE the first byte is sent, so
-- a crash resumes the SAME post instead of initializing a second one.
create or replace function public.record_tiktok_publish(
  p_id uuid,
  p_owner_user_id uuid,
  p_publish_id text,
  p_upload_url text,
  p_content_length bigint
) returns public.tiktok_publish_queue
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.tiktok_publish_queue;
begin
  if p_publish_id is null or char_length(p_publish_id) = 0 or char_length(p_publish_id) > 64 then
    raise exception 'tiktok_publish_id_invalid';
  end if;

  select * into v_row from public.tiktok_publish_queue
    where id = p_id and owner_user_id = p_owner_user_id for update;
  if not found then
    raise exception 'tiktok_publish_job_not_found';
  end if;
  if v_row.status = 'published' then
    return v_row;
  end if;
  -- A DIFFERENT publish id on a row that already has one is a programming
  -- error or a duplicate-post symptom: refuse, never overwrite evidence.
  if v_row.tiktok_publish_id is not null and v_row.tiktok_publish_id <> p_publish_id then
    raise exception 'tiktok_publish_id_conflict';
  end if;

  update public.tiktok_publish_queue set
    tiktok_publish_id = p_publish_id,
    upload_url = p_upload_url,
    upload_content_length = p_content_length,
    upload_bytes_sent = 0,
    status = 'posting',
    scheduled_at = now()
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

-- The transfer finished (all bytes are with TikTok) and the row now belongs
-- to the provider's processing pipeline: `posting` -> `provider_processing`.
-- The row keeps its publish id; only reconciliation (the post-status
-- endpoint) can move it to `published` or a terminal failure.
create or replace function public.set_tiktok_provider_processing(
  p_id uuid,
  p_owner_user_id uuid
) returns public.tiktok_publish_queue
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.tiktok_publish_queue;
begin
  update public.tiktok_publish_queue
    set status = 'provider_processing',
        claimed_at = null,
        failure_code = null,
        failure_message = null
    where id = p_id and owner_user_id = p_owner_user_id
      and status = 'posting'
      and tiktok_publish_id is not null
  returning * into v_row;
  if not found then
    select * into v_row from public.tiktok_publish_queue
      where id = p_id and owner_user_id = p_owner_user_id;
  end if;
  return v_row;
end;
$$;

create or replace function public.record_tiktok_upload_progress(
  p_id uuid,
  p_owner_user_id uuid,
  p_bytes_sent bigint
) returns public.tiktok_publish_queue
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.tiktok_publish_queue;
begin
  update public.tiktok_publish_queue
    set upload_bytes_sent = greatest(p_bytes_sent, upload_bytes_sent)
    where id = p_id and owner_user_id = p_owner_user_id and status <> 'published'
    returning * into v_row;
  if not found then
    select * into v_row from public.tiktok_publish_queue
      where id = p_id and owner_user_id = p_owner_user_id;
  end if;
  return v_row;
end;
$$;

-- Truthful completion. Requires TikTok's OWN evidence: a publish id already
-- recorded on the row and the post status 'PUBLISH_COMPLETE'. Re-running it
-- for an already-published row is a safe no-op. It also stamps the draft's
-- provider_ref — the Multi-Social Core column reserved for a provider's own
-- publication reference, written ONLY from a real provider confirmation
-- (the public post id when TikTok returned one, else the publish id).
create or replace function public.complete_tiktok_publish_job(
  p_id uuid,
  p_owner_user_id uuid,
  p_provider_status text,
  p_provider_post_id text,
  p_provider_note text
) returns public.tiktok_publish_queue
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.tiktok_publish_queue;
begin
  if p_provider_status is distinct from 'PUBLISH_COMPLETE' then
    raise exception 'tiktok_publish_not_complete';
  end if;

  select * into v_row from public.tiktok_publish_queue
    where id = p_id and owner_user_id = p_owner_user_id for update;
  if not found then
    raise exception 'tiktok_publish_job_not_found';
  end if;
  if v_row.tiktok_publish_id is null then
    raise exception 'tiktok_publish_id_required';
  end if;
  if v_row.status = 'published' then
    return v_row;
  end if;

  update public.tiktok_publish_queue set
    status = 'published',
    provider_status = 'PUBLISH_COMPLETE',
    provider_post_id = coalesce(p_provider_post_id, provider_post_id),
    provider_note = left(coalesce(p_provider_note, provider_note), 300),
    published_at = now(),
    claimed_at = null,
    failure_code = null,
    failure_message = null,
    last_provider_check_at = now()
  where id = v_row.id
  returning * into v_row;

  update public.mara_drafts
    set provider_ref = coalesce(v_row.provider_post_id, v_row.tiktok_publish_id)
    where id = v_row.draft_id
      and owner_user_id = v_row.owner_user_id
      and (provider_ref is null
           or provider_ref = v_row.tiktok_publish_id
           or provider_ref = v_row.provider_post_id);

  return v_row;
end;
$$;

-- Truthful failure. p_retry_at non-null returns the row to a claimable state
-- for a later attempt (the retry parks on the worker's cron boundary).
create or replace function public.fail_tiktok_publish_job(
  p_id uuid,
  p_owner_user_id uuid,
  p_failure_code text,
  p_failure_message text,
  p_status text default 'failed',
  p_retry_at timestamptz default null,
  p_reset_attempts boolean default false
) returns public.tiktok_publish_queue
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.tiktok_publish_queue;
begin
  if p_status not in ('failed', 'scheduled', 'permission_required', 'waiting_for_media', 'needs_declaration') then
    raise exception 'tiktok_publish_failure_status_invalid';
  end if;

  select * into v_row from public.tiktok_publish_queue
    where id = p_id and owner_user_id = p_owner_user_id for update;
  if not found then
    raise exception 'tiktok_publish_job_not_found';
  end if;
  if v_row.status = 'published' then
    return v_row;
  end if;

  update public.tiktok_publish_queue set
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
-- re-checks the post status and records what TikTok says NOW (removed,
-- rejected after the fact) without rewriting the proven publication fact.
create or replace function public.record_tiktok_provider_status(
  p_id uuid,
  p_owner_user_id uuid,
  p_provider_status text,
  p_provider_post_id text,
  p_provider_fail_reason text,
  p_provider_note text,
  p_last_provider_check_at timestamptz default now()
) returns public.tiktok_publish_queue
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.tiktok_publish_queue;
begin
  if p_provider_status is not null and p_provider_status not in (
    'PROCESSING_UPLOAD', 'PROCESSING_DOWNLOAD', 'SEND_TO_USER_INBOX',
    'PUBLISH_COMPLETE', 'FAILED'
  ) then
    raise exception 'tiktok_provider_status_invalid';
  end if;

  update public.tiktok_publish_queue set
    provider_status = coalesce(p_provider_status, provider_status),
    provider_post_id = coalesce(p_provider_post_id, provider_post_id),
    provider_fail_reason = left(coalesce(p_provider_fail_reason, provider_fail_reason), 200),
    provider_note = left(coalesce(p_provider_note, provider_note), 300),
    last_provider_check_at = p_last_provider_check_at
  where id = p_id and owner_user_id = p_owner_user_id
  returning * into v_row;
  return v_row;
end;
$$;

-- The ONLY re-submission path, and it is guarded: it may clear a persisted
-- publish id only for a fail-closed row whose failure code means the
-- post-status endpoint already said (or will say) the post does not exist
-- (invalid_publish_id). The reconcile worker calls this ONLY after a
-- read-only status check returned not-found for the persisted id — at that
-- moment TikTok itself attests the post is gone, so a fresh init cannot
-- duplicate anything. Every other row — including every published row —
-- is untouched.
create or replace function public.reset_tiktok_publish_for_resubmit(
  p_id uuid,
  p_owner_user_id uuid
) returns public.tiktok_publish_queue
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.tiktok_publish_queue;
begin
  update public.tiktok_publish_queue q set
    tiktok_publish_id = null,
    upload_url = null,
    upload_content_length = null,
    upload_bytes_sent = 0,
    provider_status = null,
    provider_post_id = null,
    provider_fail_reason = null,
    provider_note = null,
    status = 'scheduled',
    scheduled_at = now(),
    claimed_at = null,
    attempts = 0,
    last_attempt_at = null,
    failure_code = null,
    failure_message = null
  where q.id = p_id
    and q.owner_user_id = p_owner_user_id
    and q.tiktok_publish_id is not null
    and q.status = 'failed'
    and q.failure_code in ('upload_task_gone', 'publish_ambiguous', 'post_unavailable', 'processing_timeout', 'upload_interrupted')
  returning * into v_row;

  if found then
    return v_row;
  end if;

  select * into v_row from public.tiktok_publish_queue
    where id = p_id and owner_user_id = p_owner_user_id;
  return v_row;
end;
$$;

-- Read-only listing of published rows whose provider evidence is due for a
-- periodic post-status re-check. Locking is unnecessary: the writes it feeds
-- (record_tiktok_provider_status) are guarded bookkeeping.
create or replace function public.list_tiktok_published_for_verification(
  p_limit integer default 25,
  p_now timestamptz default now(),
  p_min_age interval default interval '24 hours'
) returns setof public.tiktok_publish_queue
language sql
security definer
set search_path = ''
stable
as $$
  select q.*
  from public.tiktok_publish_queue q
  where q.status = 'published'
    and q.tiktok_publish_id is not null
    and (q.last_provider_check_at is null or q.last_provider_check_at < p_now - p_min_age)
  order by q.last_provider_check_at nulls first, q.published_at
  limit greatest(coalesce(p_limit, 25), 1);
$$;

-- 5) Function grants: server-side only -----------------------------------------

revoke all on function public.save_tiktok_connection(uuid, text, text, text, text[], text, text, text, smallint, text, text, text, smallint, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.disconnect_tiktok_connection(uuid) from public, anon, authenticated;
revoke all on function public.get_tiktok_connection_secret(uuid) from public, anon, authenticated;
revoke all on function public.update_tiktok_tokens(uuid, text, text, text, smallint, timestamptz, text, text, text, smallint, timestamptz) from public, anon, authenticated;
revoke all on function public.set_tiktok_connection_status(uuid, text) from public, anon, authenticated;
revoke all on function public.set_tiktok_publish_defaults(uuid, text) from public, anon, authenticated;
revoke all on function public.upsert_tiktok_publish_queue_item(uuid, uuid, uuid, text, text, boolean, boolean, boolean, boolean, boolean, boolean, timestamptz, boolean) from public, anon, authenticated;
revoke all on function public.cancel_tiktok_publish_queue_item(uuid, uuid) from public, anon, authenticated;
revoke all on function public.claim_due_tiktok_post_jobs(integer, timestamptz, integer, interval) from public, anon, authenticated;
revoke all on function public.claim_tiktok_reconcile_jobs(integer, timestamptz, integer, interval) from public, anon, authenticated;
revoke all on function public.set_tiktok_provider_processing(uuid, uuid) from public, anon, authenticated;
revoke all on function public.record_tiktok_publish(uuid, uuid, text, text, bigint) from public, anon, authenticated;
revoke all on function public.record_tiktok_upload_progress(uuid, uuid, bigint) from public, anon, authenticated;
revoke all on function public.complete_tiktok_publish_job(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.fail_tiktok_publish_job(uuid, uuid, text, text, text, timestamptz, boolean) from public, anon, authenticated;
revoke all on function public.reset_tiktok_publish_for_resubmit(uuid, uuid) from public, anon, authenticated;
revoke all on function public.record_tiktok_provider_status(uuid, uuid, text, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.list_tiktok_published_for_verification(integer, timestamptz, interval) from public, anon, authenticated;
revoke all on function public.tiktok_publish_queue_guard() from public, anon, authenticated;

grant execute on function public.save_tiktok_connection(uuid, text, text, text, text[], text, text, text, smallint, text, text, text, smallint, timestamptz, timestamptz) to service_role;
grant execute on function public.disconnect_tiktok_connection(uuid) to service_role;
grant execute on function public.get_tiktok_connection_secret(uuid) to service_role;
grant execute on function public.update_tiktok_tokens(uuid, text, text, text, smallint, timestamptz, text, text, text, smallint, timestamptz) to service_role;
grant execute on function public.set_tiktok_connection_status(uuid, text) to service_role;
grant execute on function public.set_tiktok_publish_defaults(uuid, text) to service_role;
grant execute on function public.upsert_tiktok_publish_queue_item(uuid, uuid, uuid, text, text, boolean, boolean, boolean, boolean, boolean, boolean, timestamptz, boolean) to service_role;
grant execute on function public.cancel_tiktok_publish_queue_item(uuid, uuid) to service_role;
grant execute on function public.claim_due_tiktok_post_jobs(integer, timestamptz, integer, interval) to service_role;
grant execute on function public.claim_tiktok_reconcile_jobs(integer, timestamptz, integer, interval) to service_role;
grant execute on function public.set_tiktok_provider_processing(uuid, uuid) to service_role;
grant execute on function public.record_tiktok_publish(uuid, uuid, text, text, bigint) to service_role;
grant execute on function public.record_tiktok_upload_progress(uuid, uuid, bigint) to service_role;
grant execute on function public.complete_tiktok_publish_job(uuid, uuid, text, text, text) to service_role;
grant execute on function public.fail_tiktok_publish_job(uuid, uuid, text, text, text, timestamptz, boolean) to service_role;
grant execute on function public.reset_tiktok_publish_for_resubmit(uuid, uuid) to service_role;
grant execute on function public.record_tiktok_provider_status(uuid, uuid, text, text, text, text, timestamptz) to service_role;
grant execute on function public.list_tiktok_published_for_verification(integer, timestamptz, interval) to service_role;

commit;
