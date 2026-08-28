-- Restore only the server-side table privileges required by the Instagram
-- integration after 0004 revoked inherited defaults.

begin;

grant select on table public.instagram_connections to service_role;
grant select, insert, update on table public.instagram_oauth_states to service_role;

-- Encrypted tokens remain accessible only through the service-role-only
-- security-definer functions created in 0004.
revoke all on table public.instagram_connection_secrets from service_role;

do $$
begin
  if not (
    select relrowsecurity
    from pg_class
    where oid = 'public.instagram_connections'::regclass
  ) or not (
    select relrowsecurity
    from pg_class
    where oid = 'public.instagram_connection_secrets'::regclass
  ) or not (
    select relrowsecurity
    from pg_class
    where oid = 'public.instagram_oauth_states'::regclass
  ) then
    raise exception 'Instagram RLS must remain enabled';
  end if;
end;
$$;

commit;
