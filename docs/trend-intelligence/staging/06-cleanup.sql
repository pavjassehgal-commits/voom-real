-- Trend Intelligence — STAGING CLEANUP of committed synthetic data.
--
-- Removes everything the PostgREST/concurrency step (05) committed:
-- synthetic observations (with metrics, evidence, invalidations), the
-- STAGING-TEST decisions, and all trend audit and purge-run records.
-- Leaves the trend SCHEMA in place (use 07 rollback to remove the schema).
--
-- FAIL-SAFE: refuses to run if ANY trend decision or observation exists that
-- is not labelled STAGING-TEST — i.e. it can never delete real trend data.
-- One transaction: all or nothing. Run as the project owner (postgres).

begin;

do $cleanup$
begin
  if exists (select 1 from public.trend_source_authorizations where coalesce(reference, '') not like 'STAGING-TEST%'
                                                                  and coalesce(decided_by, '') <> 'owner:staging-test')
     or exists (select 1 from public.trend_source_coverage where coalesce(evidence, '') not like 'STAGING-TEST%')
     or exists (select 1 from public.trend_observations where subject_text not like 'STAGING-TEST%') then
    raise exception 'TREND CLEANUP REFUSED: non-synthetic trend data exists. Nothing was changed.';
  end if;
end
$cleanup$;

-- Deletions of append-only trend rows are only possible with the purge flag,
-- set for this transaction only.
select set_config('trend.purge', 'on', true);

delete from public.trend_observations;            -- cascades: metrics, evidence, invalidations
delete from public.trend_source_coverage;          -- writes audit rows, deleted below
delete from public.trend_source_authorizations;    -- writes audit rows, deleted below
delete from public.trend_audit_events;
delete from public.trend_purge_runs;

select set_config('trend.purge', 'off', true);

-- Expected: every count 0.
select
  (select count(*) from public.trend_observations) as observations,
  (select count(*) from public.trend_observation_metrics) as metrics,
  (select count(*) from public.trend_evidence) as evidence,
  (select count(*) from public.trend_observation_invalidations) as invalidations,
  (select count(*) from public.trend_source_authorizations) as authorizations,
  (select count(*) from public.trend_source_coverage) as coverage,
  (select count(*) from public.trend_audit_events) as audit_events,
  (select count(*) from public.trend_purge_runs) as purge_runs;

commit;
