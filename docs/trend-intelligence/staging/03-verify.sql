-- Trend Intelligence — STAGING POST-APPLY VERIFICATION (READ-ONLY).
-- Run right after applying 0055_trend_intelligence.sql. Changes nothing.
-- Every row must show ok = true. If any row is false, STOP and use 07-rollback.

with
tables as (
  select c.relname, c.relrowsecurity,
         (select count(*) from pg_catalog.pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'trend\_%'
),
table_grants as (
  select grantee, table_name, privilege_type from information_schema.role_table_grants
   where table_schema = 'public' and table_name like 'trend\_%' and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
),
routine_grants as (
  select grantee, routine_name from information_schema.role_routine_grants
   where routine_schema = 'public' and routine_name like 'trend\_%' and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
)
select check_name, value, expected, value = expected as ok
from (
  values
    ('10 trend tables', (select count(*)::text from tables), '10'),
    ('RLS enabled on every trend table', (select bool_and(relrowsecurity)::text from tables), 'true'),
    ('zero RLS policies on trend tables', (select sum(policies)::text from tables), '0'),
    ('anon/authenticated/PUBLIC: no table grants',
      (select count(*)::text from table_grants where grantee <> 'service_role'), '0'),
    ('service_role: SELECT only, on all 10 tables',
      (select count(*)::text || '/' || count(*) filter (where privilege_type = 'SELECT')::text from table_grants where grantee = 'service_role'), '10/10'),
    ('function EXECUTE grants: exactly the 4 service RPCs',
      (select string_agg(grantee || ':' || routine_name, ',' order by routine_name) from routine_grants),
      'service_role:trend_list_usable_observations,service_role:trend_retention_status,service_role:trend_run_retention_purge,service_role:trend_store_observation'),
    ('invalidation RPC disabled for every API role',
      (has_function_privilege('service_role', 'public.trend_invalidate_observation(uuid, text, text, text)', 'EXECUTE')
        or has_function_privilege('authenticated', 'public.trend_invalidate_observation(uuid, text, text, text)', 'EXECUTE')
        or has_function_privilege('anon', 'public.trend_invalidate_observation(uuid, text, text, text)', 'EXECUTE'))::text, 'false'),
    ('audit sequence not usable by API roles',
      (has_sequence_privilege('service_role', 'public.trend_audit_events_seq_seq', 'USAGE')
        or has_sequence_privilege('anon', 'public.trend_audit_events_seq_seq', 'USAGE')
        or has_sequence_privilege('authenticated', 'public.trend_audit_events_seq_seq', 'USAGE'))::text, 'false'),
    ('SECURITY DEFINER functions pin search_path',
      (select bool_and(exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=pg_catalog,%pg_temp'))::text
         from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'trend\_%' and p.prosecdef), 'true'),
    ('source registry rows', (select count(*)::text from public.trend_sources), '4'),
    ('YouTube retention cap (days)', (select max_retention_days::text from public.trend_sources where source_id = 'youtube_data_api'), '30'),
    ('metric definition versions', (select count(*)::text from public.trend_metric_definitions), '7'),
    ('review/retention settings (days: approval, coverage, audit, purge runs)',
      (extract(day from public.trend_authorization_review_period()))::text || ',' ||
      (extract(day from public.trend_coverage_review_period()))::text || ',' ||
      (extract(day from public.trend_audit_retention_period()))::text || ',' ||
      (extract(day from public.trend_purge_run_retention_period()))::text, '365,180,730,90'),
    ('no source is approved yet (deny by default)', (select count(*)::text from public.trend_source_authorizations), '0'),
    ('no coverage recorded yet', (select count(*)::text from public.trend_source_coverage), '0'),
    ('no observations stored', (select count(*)::text from public.trend_observations), '0'),
    ('no purge schedule: pg_cron not installed', (select count(*)::text from pg_catalog.pg_extension where extname = 'pg_cron'), '0'),
    ('admin tables untouched (still 4)',
      (select count(*)::text from pg_catalog.pg_tables where schemaname = 'public'
        and tablename in ('admin_memberships', 'admin_audit_events', 'admin_invitations', 'admin_audit_denial_counters')), '4')
) as checks(check_name, value, expected);
