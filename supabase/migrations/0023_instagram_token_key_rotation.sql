-- 0023_instagram_token_key_rotation.sql
--
-- Safe Instagram token encryption-key rotation.
--
-- STATUS: PREPARED FOR REVIEW. Do not apply without explicit approval.
--   Migrations 0001-0022 are already live and are NOT re-run by this file.
--
-- Why this exists:
--   Voom needs to move to a new INSTAGRAM_TOKEN_ENCRYPTION_KEY without making
--   the three existing connections (synrapay.ai and two vibeblingmerch)
--   unreadable. The application gains dual-key support (new primary key for all
--   writes, legacy key accepted for decryption only) and a one-off re-encryption
--   job. This migration provides the two server-only entry points that job
--   needs, plus a key_version passthrough on the existing save function.
--
-- Why RPCs rather than direct table access:
--   0005 deliberately does `revoke all on table
--   public.instagram_connection_secrets from service_role`. Encrypted tokens are
--   reachable ONLY through service-role security-definer functions. This file
--   keeps that invariant exactly as it is: no new table grants are issued.
--
-- What this file changes:
--   1. save_instagram_connection gains an OPTIONAL p_key_version parameter
--      (defaulted, so the existing 11-argument call site keeps working).
--   2. list_instagram_connection_secrets() — read every stored secret, for the
--      rotation job only.
--   3. update_instagram_connection_secret(...) — replace ONLY the ciphertext
--      columns for one owner. Cannot touch scopes, status or any metadata.
--
-- Rollback:
--   drop function if exists public.update_instagram_connection_secret(uuid, text, text, text, smallint);
--   drop function if exists public.list_instagram_connection_secrets();
--   drop function if exists public.save_instagram_connection(uuid, text, text, text, text, text, text[], timestamptz, text, text, text, smallint);
--   -- then re-create the 11-argument save_instagram_connection from 0004.

begin;

-- 1) save_instagram_connection: persist the real key version --------------
-- The 0004 version hard-coded key_version = 1. New writes are now v2, so the
-- caller supplies it. p_key_version is DEFAULTED, which keeps this
-- backward-compatible: the pre-existing 11-argument signature is dropped only
-- after the new one is in place, and callers that omit it still get 1.

create or replace function public.save_instagram_connection(
  p_owner_user_id uuid,
  p_instagram_user_id text,
  p_username text,
  p_display_name text,
  p_account_type text,
  p_profile_picture_url text,
  p_scopes text[],
  p_token_expires_at timestamptz,
  p_encrypted_access_token text,
  p_token_iv text,
  p_token_auth_tag text,
  p_key_version smallint default 1
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  connection_uuid uuid;
begin
  insert into public.instagram_connections (
    owner_user_id, instagram_user_id, username, display_name, account_type,
    profile_picture_url, scopes, status, token_expires_at, last_synced_at,
    connected_at, disconnected_at
  ) values (
    p_owner_user_id, p_instagram_user_id, p_username, p_display_name, p_account_type,
    p_profile_picture_url, p_scopes, 'connected', p_token_expires_at, now(), now(), null
  )
  on conflict (owner_user_id) do update set
    instagram_user_id = excluded.instagram_user_id,
    username = excluded.username,
    display_name = excluded.display_name,
    account_type = excluded.account_type,
    profile_picture_url = excluded.profile_picture_url,
    scopes = excluded.scopes,
    status = 'connected',
    token_expires_at = excluded.token_expires_at,
    last_synced_at = now(),
    connected_at = now(),
    disconnected_at = null
  returning id into connection_uuid;

  insert into public.instagram_connection_secrets (
    connection_id, owner_user_id, encrypted_access_token, token_iv, token_auth_tag, key_version
  ) values (
    connection_uuid, p_owner_user_id, p_encrypted_access_token, p_token_iv,
    p_token_auth_tag, coalesce(p_key_version, 1)
  )
  on conflict (connection_id) do update set
    owner_user_id = excluded.owner_user_id,
    encrypted_access_token = excluded.encrypted_access_token,
    token_iv = excluded.token_iv,
    token_auth_tag = excluded.token_auth_tag,
    key_version = excluded.key_version;

  return connection_uuid;
end;
$$;

-- Retire the old 11-argument overload so there is exactly one definition and
-- PostgREST cannot pick an ambiguous candidate.
drop function if exists public.save_instagram_connection(
  uuid, text, text, text, text, text, text[], timestamptz, text, text, text
);

revoke all on function public.save_instagram_connection(
  uuid, text, text, text, text, text, text[], timestamptz, text, text, text, smallint
) from public, anon, authenticated;
grant execute on function public.save_instagram_connection(
  uuid, text, text, text, text, text, text[], timestamptz, text, text, text, smallint
) to service_role;

-- 2) Read every stored secret, for the rotation job only ------------------
-- Returns ciphertext only. There is no plaintext anywhere in the database:
-- decryption happens exclusively in the Node server process.
create or replace function public.list_instagram_connection_secrets()
returns table (
  owner_user_id uuid,
  encrypted_access_token text,
  token_iv text,
  token_auth_tag text,
  key_version smallint
)
language sql
security definer
set search_path = ''
stable
as $$
  select s.owner_user_id, s.encrypted_access_token, s.token_iv,
    s.token_auth_tag, s.key_version
  from public.instagram_connection_secrets s
  order by s.owner_user_id;
$$;

revoke all on function public.list_instagram_connection_secrets() from public, anon, authenticated;
grant execute on function public.list_instagram_connection_secrets() to service_role;

-- 3) Replace ONLY the ciphertext for one owner ----------------------------
-- Deliberately cannot modify username, scopes, status, token_expires_at or any
-- other metadata, so a rotation can never damage a live connection. Returns
-- true only when a row actually changed.
create or replace function public.update_instagram_connection_secret(
  p_owner_user_id uuid,
  p_encrypted_access_token text,
  p_token_iv text,
  p_token_auth_tag text,
  p_key_version smallint
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
begin
  if p_encrypted_access_token is null or char_length(p_encrypted_access_token) = 0
     or p_token_iv is null or char_length(p_token_iv) = 0
     or p_token_auth_tag is null or char_length(p_token_auth_tag) = 0 then
    raise exception 'instagram_secret_payload_invalid';
  end if;

  update public.instagram_connection_secrets set
    encrypted_access_token = p_encrypted_access_token,
    token_iv = p_token_iv,
    token_auth_tag = p_token_auth_tag,
    key_version = coalesce(p_key_version, 1)
  where owner_user_id = p_owner_user_id;

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

revoke all on function public.update_instagram_connection_secret(uuid, text, text, text, smallint) from public, anon, authenticated;
grant execute on function public.update_instagram_connection_secret(uuid, text, text, text, smallint) to service_role;

-- 4) The secrets table keeps its existing protections: RLS on, no direct
--    service_role table grants. Nothing below re-grants anything.
do $$
begin
  if not (
    select relrowsecurity from pg_class
    where oid = 'public.instagram_connection_secrets'::regclass
  ) then
    raise exception 'Instagram secret RLS must remain enabled';
  end if;
end;
$$;

commit;
