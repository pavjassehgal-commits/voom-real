-- Trend Intelligence — 0056 STAGING VERIFICATION (READ-ONLY).
-- Run immediately after applying 0056. Changes nothing.
-- Every row must show ok = true. If any row is false, STOP and run the 0056
-- rollback before considering the 0055 rollback.

select check_name, value, expected, value = expected as ok
from (
  values
    ('trend_mara_contexts exists',
      (to_regclass('public.trend_mara_contexts') is not null)::text, 'true'),
    ('RLS enabled',
      coalesce((select relrowsecurity::text from pg_catalog.pg_class
        where oid = 'public.trend_mara_contexts'::regclass), 'false'), 'true'),
    ('zero RLS policies',
      (select count(*)::text from pg_catalog.pg_policies
        where schemaname = 'public' and tablename = 'trend_mara_contexts'), '0'),
    ('anon/authenticated/PUBLIC: no table grants',
      (select count(*)::text from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'trend_mara_contexts'
          and grantee in ('anon', 'authenticated', 'PUBLIC')), '0'),
    ('service_role: SELECT only',
      coalesce((select string_agg(privilege_type, ',' order by privilege_type)
        from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'trend_mara_contexts'
          and grantee = 'service_role'), ''), 'SELECT'),
    ('service_role cannot INSERT',
      has_table_privilege('service_role', 'public.trend_mara_contexts', 'INSERT')::text, 'false'),
    ('service_role cannot UPDATE',
      has_table_privilege('service_role', 'public.trend_mara_contexts', 'UPDATE')::text, 'false'),
    ('service_role cannot DELETE',
      has_table_privilege('service_role', 'public.trend_mara_contexts', 'DELETE')::text, 'false'),
    ('0055 observations still present',
      (to_regclass('public.trend_observations') is not null)::text, 'true'),
    ('admin tables untouched (still 4)',
      (select count(*)::text from pg_catalog.pg_tables where schemaname = 'public'
        and tablename in ('admin_memberships', 'admin_audit_events', 'admin_invitations', 'admin_audit_denial_counters')), '4')
) as checks(check_name, value, expected);
