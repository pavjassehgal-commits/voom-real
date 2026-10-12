-- ROLLBACK for supabase/proposed/trend_intelligence_governance.sql.
--
-- Removes the RPCs, corrections, audit trail and purge records, and the
-- columns and constraints the governance file added. Refuses to run while a
-- corrected revision (revision > 1) exists, because the Stage 2A identity
-- cannot represent it. Destroys the audit trail and invalidation history.
--
-- AFTER this file, re-apply supabase/proposed/trend_intelligence_storage.sql
-- (idempotent) to restore the Stage 2A guard functions, purge function and
-- grants exactly. To remove everything, run this file and then
-- trend_intelligence_storage.rollback.sql.

begin;

do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'trend_observations' and column_name = 'revision')
     and exists (select 1 from public.trend_observations where revision > 1) then
    raise exception 'trend_rollback_blocked_by_corrected_revisions';
  end if;
end
$$;

drop function if exists public.trend_store_observation(jsonb, uuid);
drop function if exists public.trend_invalidate_observation(uuid, text, text, text);
drop function if exists public.trend_run_retention_purge(integer);
drop function if exists public.trend_retention_status();
drop function if exists public.trend_list_usable_observations(text, text, text, integer, timestamptz, uuid);

drop trigger if exists trend_observations_guard_revision on public.trend_observations;
drop trigger if exists trend_observations_purge_only on public.trend_observations;
drop trigger if exists trend_authorizations_decision_update on public.trend_source_authorizations;
drop trigger if exists trend_coverage_decision_update on public.trend_source_coverage;
drop trigger if exists trend_authorizations_audit on public.trend_source_authorizations;
drop trigger if exists trend_coverage_audit on public.trend_source_coverage;

drop table if exists public.trend_purge_runs;
drop table if exists public.trend_audit_events;
drop table if exists public.trend_observation_invalidations;

drop function if exists public.trend_guard_observation_revision();
drop function if exists public.trend_guard_purge_only();
drop function if exists public.trend_audit_policy_change();
drop function if exists public.trend_guard_decision_update();
drop function if exists public.trend_authorization_review_period();
drop function if exists public.trend_coverage_review_period();
drop function if exists public.trend_audit_retention_period();
drop function if exists public.trend_purge_run_retention_period();

alter table public.trend_observations drop constraint if exists trend_observations_identity_key;
alter table public.trend_observations drop constraint if exists trend_observations_revision_shape;
alter table public.trend_observations drop column if exists replaces_observation_id;
alter table public.trend_observations drop column if exists revision;
alter table public.trend_observations add constraint trend_observations_identity_key
  unique (source_id, trend_key, window_start, window_end);

alter table public.trend_source_coverage drop constraint if exists trend_source_coverage_checked_by;
alter table public.trend_source_coverage drop column if exists checked_by;
alter table public.trend_source_authorizations drop constraint if exists trend_source_authorizations_decision_reference;
alter table public.trend_sources drop constraint if exists trend_sources_freshness_order;
alter table public.trend_sources drop column if exists fresh_for;
alter table public.trend_sources drop column if exists stale_after;
alter table public.trend_sources drop column if exists expires_after;

commit;
