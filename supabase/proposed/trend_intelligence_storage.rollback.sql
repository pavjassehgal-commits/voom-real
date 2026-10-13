-- ROLLBACK for the proposed Trend Intelligence storage
-- (supabase/proposed/trend_intelligence_storage.sql).
--
-- Removes every object that file creates, in dependency order. Nothing else
-- in the schema references these objects. Destroys all stored trend data.

begin;

drop function if exists public.trend_purge_expired(integer);

drop table if exists public.trend_evidence;
drop table if exists public.trend_observation_metrics;
drop table if exists public.trend_observations;
drop table if exists public.trend_source_coverage;
drop table if exists public.trend_source_authorizations;
drop table if exists public.trend_metric_definitions;
drop table if exists public.trend_sources;

drop function if exists public.trend_check_observation_complete();
drop function if exists public.trend_guard_evidence_insert();
drop function if exists public.trend_guard_metric_insert();
drop function if exists public.trend_guard_immutable();
drop function if exists public.trend_guard_observation_insert();

commit;
