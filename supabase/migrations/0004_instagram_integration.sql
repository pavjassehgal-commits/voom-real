-- Real Instagram connection metadata, encrypted-token storage, and OAuth state.
-- Tokens and OAuth state are service-role-only; authenticated clients can read
-- only their sanitized connection metadata. Safe to re-run.

begin;

create table if not exists public.instagram_connections (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null unique references auth.users (id) on delete cascade,
  instagram_user_id text not null,
  username text not null check (char_length(username) between 1 and 100),
  display_name text check (display_name is null or char_length(display_name) <= 200),
  account_type text check (account_type is null or account_type in ('BUSINESS', 'MEDIA_CREATOR', 'CREATOR')),
  profile_picture_url text check (profile_picture_url is null or char_length(profile_picture_url) <= 2048),
  scopes text[] not null default '{}',
  status text not null default 'connected' check (status in ('connected', 'expired', 'revoked', 'error', 'disconnected')),
  token_expires_at timestamptz,
  last_synced_at timestamptz,
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_user_id)
);

create table if not exists public.instagram_connection_secrets (
  connection_id uuid primary key references public.instagram_connections (id) on delete cascade,
  owner_user_id uuid not null unique references auth.users (id) on delete cascade,
  encrypted_access_token text not null,
  token_iv text not null,
  token_auth_tag text not null,
  key_version smallint not null default 1 check (key_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (connection_id, owner_user_id)
    references public.instagram_connections (id, owner_user_id) on delete cascade
);

create table if not exists public.instagram_oauth_states (
  state_hash text primary key,
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists instagram_connections_owner_idx on public.instagram_connections (owner_user_id);
create index if not exists instagram_oauth_states_owner_expiry_idx on public.instagram_oauth_states (owner_user_id, expires_at);

drop trigger if exists set_instagram_connections_updated_at on public.instagram_connections;
create trigger set_instagram_connections_updated_at before update on public.instagram_connections
  for each row execute function public.set_updated_at();
drop trigger if exists set_instagram_connection_secrets_updated_at on public.instagram_connection_secrets;
create trigger set_instagram_connection_secrets_updated_at before update on public.instagram_connection_secrets
  for each row execute function public.set_updated_at();

alter table public.instagram_connections enable row level security;
alter table public.instagram_connection_secrets enable row level security;
alter table public.instagram_oauth_states enable row level security;

revoke all on table public.instagram_connections, public.instagram_connection_secrets, public.instagram_oauth_states from anon, authenticated;
grant select on table public.instagram_connections to authenticated;

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
  p_token_auth_tag text
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
    connection_uuid, p_owner_user_id, p_encrypted_access_token, p_token_iv, p_token_auth_tag, 1
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

create or replace function public.disconnect_instagram_connection(p_owner_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_count integer;
begin
  delete from public.instagram_connection_secrets where owner_user_id = p_owner_user_id;
  update public.instagram_connections
    set status = 'disconnected', disconnected_at = now(), token_expires_at = null
    where owner_user_id = p_owner_user_id;
  get diagnostics changed_count = row_count;
  return changed_count > 0;
end;
$$;

revoke all on function public.save_instagram_connection(uuid, text, text, text, text, text, text[], timestamptz, text, text, text) from public, anon, authenticated;
revoke all on function public.disconnect_instagram_connection(uuid) from public, anon, authenticated;
grant execute on function public.save_instagram_connection(uuid, text, text, text, text, text, text[], timestamptz, text, text, text) to service_role;
grant execute on function public.disconnect_instagram_connection(uuid) to service_role;

drop policy if exists "instagram_connections_select_own" on public.instagram_connections;
create policy "instagram_connections_select_own" on public.instagram_connections for select to authenticated
  using ((select auth.uid()) = owner_user_id);

-- No client policies are intentionally created for token or OAuth-state tables.
-- Only the server-side service role may access them.

commit;
