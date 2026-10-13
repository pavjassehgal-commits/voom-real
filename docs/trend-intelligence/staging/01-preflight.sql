-- Trend Intelligence — STAGING PREFLIGHT (READ-ONLY).
-- Run in the voom-staging SQL editor (project qcdpegwjofrqnfudyrqq) BEFORE
-- applying 0055_trend_intelligence.sql. Changes nothing.
-- Every row must show ok = true. If any row is false, STOP.

select check_name, value, expected, value = expected as ok
from (
  values
    ('no trend objects exist yet',
      (select count(*)::text from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname like 'trend\_%')
      || '/' ||
      (select count(*)::text from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'trend\_%'),
      '0/0'),
    ('admin migrations 0052-0054 present (staging only)',
      (select count(*)::text from pg_catalog.pg_tables where schemaname = 'public'
        and tablename in ('admin_memberships', 'admin_audit_events', 'admin_invitations', 'admin_audit_denial_counters')),
      '4'),
    ('0051 present (voom_rate_limits)',
      (to_regclass('public.voom_rate_limits') is not null)::text, 'true'),
    ('server version >= 13 (pg_current_xact_id)',
      (current_setting('server_version_num')::int >= 130000)::text, 'true'),
    ('pg_cron and pg_net NOT installed',
      (select count(*)::text from pg_catalog.pg_extension where extname in ('pg_cron', 'pg_net')), '0'),
    ('API roles exist',
      (select count(*)::text from pg_catalog.pg_roles where rolname in ('anon', 'authenticated', 'service_role')), '3'),
    ('current user can act as each API role (for the role tests)',
      (pg_has_role(current_user, 'anon', 'member') and pg_has_role(current_user, 'authenticated', 'member')
        and pg_has_role(current_user, 'service_role', 'member'))::text, 'true'),
    ('running as the schema owner role',
      current_user::text, 'postgres')
) as checks(check_name, value, expected)
union all
-- Informational (no expectation): record these values in the results document.
select 'INFO server_version', current_setting('server_version'), '(record)', true
union all
select 'INFO public table count before apply', (select count(*)::text from pg_catalog.pg_tables where schemaname = 'public'), '(record)', true
union all
select 'INFO CLI migration history table present',
  (to_regclass('supabase_migrations.schema_migrations') is not null)::text, '(record)', true;
