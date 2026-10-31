-- Automatic renewal of Instagram long-lived access tokens
-- (Instagram API with Instagram Login).
--
-- Meta: a long-lived token lasts 60 days; GET /refresh_access_token renews it
-- for another 60 days only while it is at least 24 hours old and unexpired.
-- An expired token can never be refreshed, so the owner must reconnect.
--
-- Adds renewal bookkeeping to the service-only secrets table and three
-- service-role-only functions. The worker claims due rows with
-- `for update skip locked` plus a lease, so concurrent runs never renew the
-- same connection twice. Completion swaps the ciphertext and expiry in one
-- transaction and only for the claim that is still current; a reconnect in the
-- meantime (connected_at changes) makes the result stale and it is discarded.
-- A failed renewal never clears the stored credential.
--
-- Locks are taken connections -> secrets, the same order as
-- save_instagram_connection, so renewal cannot deadlock a reconnect.
-- No data is backfilled and no provider is called. Safe to re-run.

begin;

alter table public.instagram_connection_secrets
  add column if not exists token_refreshed_at timestamptz,
  add column if not exists refresh_claim_id uuid,
  add column if not exists refresh_claimed_at timestamptz,
  add column if not exists refresh_failure_count integer not null default 0,
  add column if not exists refresh_last_error text,
  add column if not exists refresh_next_attempt_at timestamptz;

alter table public.instagram_connection_secrets
  drop constraint if exists instagram_connection_secrets_refresh_failure_count_check,
  add constraint instagram_connection_secrets_refresh_failure_count_check check (refresh_failure_count >= 0),
  drop constraint if exists instagram_connection_secrets_refresh_last_error_check,
  add constraint instagram_connection_secrets_refresh_last_error_check check (
    refresh_last_error is null or refresh_last_error in (
      'rate_limited', 'unavailable', 'invalid_response', 'token_invalid',
      'permission_missing', 'decrypt_failed', 'encrypt_failed'
    )
  );

create index if not exists instagram_connections_renewal_idx
  on public.instagram_connections (token_expires_at)
  where status = 'connected';

-- 1) Claim due connections ------------------------------------------------
-- Returns ciphertext only; decryption happens in the Node server process.
create or replace function public.claim_instagram_token_refreshes(
  p_limit integer,
  p_renew_before interval,
  p_lease interval
) returns table (
  owner_user_id uuid,
  claim_id uuid,
  connected_at timestamptz,
  token_expires_at timestamptz,
  encrypted_access_token text,
  token_iv text,
  token_auth_tag text,
  key_version smallint
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'instagram_refresh_limit_invalid';
  end if;
  if p_renew_before is null or p_renew_before < interval '2 days' or p_renew_before > interval '58 days' then
    raise exception 'instagram_refresh_window_invalid';
  end if;
  if p_lease is null or p_lease < interval '1 minute' or p_lease > interval '1 hour' then
    raise exception 'instagram_refresh_lease_invalid';
  end if;

  return query
  with due as (
    select c.id
    from public.instagram_connections c
    join public.instagram_connection_secrets s
      on s.connection_id = c.id and s.owner_user_id = c.owner_user_id
    where c.status = 'connected'
      and c.token_expires_at is not null
      and c.token_expires_at > now() + interval '5 minutes'
      and c.token_expires_at <= now() + p_renew_before
      -- Meta refuses tokens younger than 24 hours.
      and c.connected_at <= now() - interval '1 day'
      and (s.token_refreshed_at is null or s.token_refreshed_at <= now() - interval '1 day')
      and (s.refresh_next_attempt_at is null or s.refresh_next_attempt_at <= now())
      and (s.refresh_claimed_at is null or s.refresh_claimed_at < now() - p_lease)
    order by c.token_expires_at
    limit p_limit
    for update of c, s skip locked
  ), claimed as (
    update public.instagram_connection_secrets s set
      refresh_claim_id = gen_random_uuid(),
      refresh_claimed_at = now()
    from due
    where s.connection_id = due.id
    returning s.connection_id, s.owner_user_id, s.refresh_claim_id,
      s.encrypted_access_token, s.token_iv, s.token_auth_tag, s.key_version
  )
  select cl.owner_user_id, cl.refresh_claim_id, c.connected_at, c.token_expires_at,
    cl.encrypted_access_token, cl.token_iv, cl.token_auth_tag, cl.key_version
  from claimed cl
  join public.instagram_connections c on c.id = cl.connection_id
  order by c.token_expires_at;
end;
$$;

-- 2) Store a renewed token for the current claim only ---------------------
create or replace function public.complete_instagram_token_refresh(
  p_owner_user_id uuid,
  p_claim_id uuid,
  p_connected_at timestamptz,
  p_encrypted_access_token text,
  p_token_iv text,
  p_token_auth_tag text,
  p_key_version smallint,
  p_token_expires_at timestamptz
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection uuid;
  v_updated integer;
begin
  if p_encrypted_access_token is null or char_length(p_encrypted_access_token) = 0
     or p_token_iv is null or char_length(p_token_iv) = 0
     or p_token_auth_tag is null or char_length(p_token_auth_tag) = 0 then
    raise exception 'instagram_secret_payload_invalid';
  end if;
  if p_token_expires_at is null or p_token_expires_at <= now() + interval '1 day'
     or p_token_expires_at > now() + interval '90 days' then
    raise exception 'instagram_refresh_expiry_invalid';
  end if;

  select c.id into v_connection
  from public.instagram_connections c
  where c.owner_user_id = p_owner_user_id
    and c.status = 'connected'
    and c.connected_at = p_connected_at
  for update;
  if v_connection is null then return false; end if;

  update public.instagram_connection_secrets set
    encrypted_access_token = p_encrypted_access_token,
    token_iv = p_token_iv,
    token_auth_tag = p_token_auth_tag,
    key_version = coalesce(p_key_version, 1),
    token_refreshed_at = now(),
    refresh_claim_id = null,
    refresh_claimed_at = null,
    refresh_failure_count = 0,
    refresh_last_error = null,
    refresh_next_attempt_at = null
  where connection_id = v_connection
    and owner_user_id = p_owner_user_id
    and refresh_claim_id = p_claim_id;
  get diagnostics v_updated = row_count;
  if v_updated = 0 then return false; end if;

  update public.instagram_connections set token_expires_at = p_token_expires_at
  where id = v_connection and owner_user_id = p_owner_user_id;
  return true;
end;
$$;

-- 3) Record a failed renewal, keeping the stored credential ---------------
-- p_connection_status 'expired' / 'revoked' marks a token Meta rejected, so
-- every reader shows Reconnect; null leaves the connection usable and retries
-- at p_retry_at.
create or replace function public.fail_instagram_token_refresh(
  p_owner_user_id uuid,
  p_claim_id uuid,
  p_connected_at timestamptz,
  p_error_code text,
  p_retry_at timestamptz,
  p_connection_status text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection uuid;
  v_updated integer;
begin
  if p_connection_status is not null and p_connection_status not in ('expired', 'revoked') then
    raise exception 'instagram_refresh_status_invalid';
  end if;
  if p_retry_at is not null and (p_retry_at <= now() or p_retry_at > now() + interval '7 days') then
    raise exception 'instagram_refresh_retry_invalid';
  end if;

  select c.id into v_connection
  from public.instagram_connections c
  where c.owner_user_id = p_owner_user_id
    and c.status = 'connected'
    and c.connected_at = p_connected_at
  for update;
  if v_connection is null then return false; end if;

  update public.instagram_connection_secrets set
    refresh_claim_id = null,
    refresh_claimed_at = null,
    refresh_failure_count = refresh_failure_count + 1,
    refresh_last_error = p_error_code,
    refresh_next_attempt_at = p_retry_at
  where connection_id = v_connection
    and owner_user_id = p_owner_user_id
    and refresh_claim_id = p_claim_id;
  get diagnostics v_updated = row_count;
  if v_updated = 0 then return false; end if;

  if p_connection_status is not null then
    update public.instagram_connections set status = p_connection_status
    where id = v_connection and owner_user_id = p_owner_user_id;
  end if;
  return true;
end;
$$;

-- 4) Mark tokens that already lapsed --------------------------------------
-- Meta cannot refresh an expired token; the status lets every reader show
-- Reconnect instead of a connection that silently fails.
create or replace function public.expire_lapsed_instagram_tokens()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
begin
  update public.instagram_connections set status = 'expired'
  where status = 'connected'
    and token_expires_at is not null
    and token_expires_at <= now();
  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

revoke all on function public.claim_instagram_token_refreshes(integer, interval, interval) from public, anon, authenticated;
revoke all on function public.complete_instagram_token_refresh(uuid, uuid, timestamptz, text, text, text, smallint, timestamptz) from public, anon, authenticated;
revoke all on function public.fail_instagram_token_refresh(uuid, uuid, timestamptz, text, timestamptz, text) from public, anon, authenticated;
revoke all on function public.expire_lapsed_instagram_tokens() from public, anon, authenticated;
grant execute on function public.claim_instagram_token_refreshes(integer, interval, interval) to service_role;
grant execute on function public.complete_instagram_token_refresh(uuid, uuid, timestamptz, text, text, text, smallint, timestamptz) to service_role;
grant execute on function public.fail_instagram_token_refresh(uuid, uuid, timestamptz, text, timestamptz, text) to service_role;
grant execute on function public.expire_lapsed_instagram_tokens() to service_role;

commit;
