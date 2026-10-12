-- ROLLBACK for the integration candidate 0055_trend_intelligence.sql.
--
-- Removes EVERY object the candidate creates, and nothing else. It does not
-- touch any table, function, policy or grant from 0001–0054. One
-- transaction: all or nothing.
--
-- DESTROYS ALL TREND DATA, including the append-only audit trail,
-- invalidations and purge records. On voom-staging that is synthetic test
-- data only; never run it anywhere real trend data exists without an export
-- the owner has approved.

begin;

-- Functions first (RPCs, purge, settings). Trigger functions go with their
-- tables below; plpgsql bodies are not dependencies, so order is safe.
drop function if exists public.trend_store_observation(jsonb, uuid);
drop function if exists public.trend_list_usable_observations(text, text, text, integer, timestamptz, uuid);
drop function if exists public.trend_invalidate_observation(uuid, text, text, text);
drop function if exists public.trend_run_retention_purge(integer);
drop function if exists public.trend_retention_status();
drop function if exists public.trend_purge_expired(integer);

-- Tables (children before parents). Dropping a table drops its triggers,
-- indexes, constraints, identity sequence and grants.
drop table if exists public.trend_purge_runs;
drop table if exists public.trend_audit_events;
drop table if exists public.trend_observation_invalidations;
drop table if exists public.trend_evidence;
drop table if exists public.trend_observation_metrics;
drop table if exists public.trend_observations;
drop table if exists public.trend_source_coverage;
drop table if exists public.trend_source_authorizations;
drop table if exists public.trend_metric_definitions;
drop table if exists public.trend_sources;

-- Trigger and settings functions.
drop function if exists public.trend_guard_observation_insert();
drop function if exists public.trend_guard_observation_revision();
drop function if exists public.trend_guard_metric_insert();
drop function if exists public.trend_guard_evidence_insert();
drop function if exists public.trend_check_observation_complete();
drop function if exists public.trend_guard_immutable();
drop function if exists public.trend_guard_purge_only();
drop function if exists public.trend_audit_policy_change();
drop function if exists public.trend_guard_decision_update();
drop function if exists public.trend_authorization_review_period();
drop function if exists public.trend_coverage_review_period();
drop function if exists public.trend_audit_retention_period();
drop function if exists public.trend_purge_run_retention_period();

-- Nothing named trend_* may remain.
do $$
begin
  if exists (select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relname like 'trend\_%')
     or exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname like 'trend\_%') then
    raise exception 'trend_rollback_incomplete';
  end if;
end
$$;

commit;
