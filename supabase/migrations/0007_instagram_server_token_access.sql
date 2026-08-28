-- Narrow service-role-only token retrieval for Instagram API calls.

begin;

create or replace function public.get_instagram_connection_secret(p_owner_user_id uuid)
returns table (
  instagram_user_id text,
  encrypted_access_token text,
  token_iv text,
  token_auth_tag text,
  token_expires_at timestamptz,
  connection_status text
)
language sql
security definer
set search_path = ''
stable
as $$
  select c.instagram_user_id, s.encrypted_access_token, s.token_iv,
    s.token_auth_tag, c.token_expires_at, c.status
  from public.instagram_connections c
  join public.instagram_connection_secrets s
    on s.connection_id = c.id and s.owner_user_id = c.owner_user_id
  where c.owner_user_id = p_owner_user_id
  limit 1;
$$;

revoke all on function public.get_instagram_connection_secret(uuid) from public, anon, authenticated;
grant execute on function public.get_instagram_connection_secret(uuid) to service_role;

commit;
