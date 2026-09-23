-- DEPLOYMENT GATE: read docs/auth/production-rollout.md BEFORE applying.
-- This does not confirm, backfill, or otherwise modify auth.users.
begin;

-- Read the authoritative record, not user metadata or a potentially stale JWT.
-- Narrow definer function returns only the calling user's boolean state.
create or replace function public.voom_has_verified_email()
returns boolean
language sql stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from auth.users u
    where u.id = (select auth.uid())
      and u.email is not null and u.email <> ''
      and u.email_confirmed_at is not null
      and coalesce(u.is_anonymous, false) = false
  );
$$;
revoke all on function public.voom_has_verified_email() from public, anon;
grant execute on function public.voom_has_verified_email() to authenticated, service_role;

-- RESTRICTIVE is crucial: another permissive ownership policy must NOT bypass
-- verification. Existing owner predicates still apply. Service-role jobs retain
-- their existing BYPASSRLS behavior. Cover every current public RLS table,
-- including service-only tables; grant no new table or storage privileges.
do $$
declare t record;
begin
  for t in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relrowsecurity
  loop
    execute format('drop policy if exists voom_verified_email on public.%I', t.relname);
    execute format(
      'create policy voom_verified_email on public.%I as restrictive for all to authenticated using ((select public.voom_has_verified_email())) with check ((select public.voom_has_verified_email()))',
      t.relname
    );
  end loop;
end $$;

-- Future product tables must enable RLS and include this restrictive policy.
-- Storage remains server-written with existing private/signed or intentionally
-- public delivery URLs. No new public storage access is introduced.
commit;
