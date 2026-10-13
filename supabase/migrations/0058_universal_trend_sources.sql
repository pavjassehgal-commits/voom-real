-- 0058_universal_trend_sources.sql: proposed source-registry addition only.
-- Adds two free, keyless, legitimately licensed signal sources to the 0055
-- registry so Trend Intelligence can serve businesses in many industries:
--   public_holidays_nager: official public holidays by country (Nager.Date,
--                          MIT open source); calendar facts, no popularity.
--   wikimedia_pageviews:   daily most-viewed Wikipedia articles per language
--                          edition (Wikimedia Analytics API, CC0); measured
--                          reader attention, stored under worldwide market ZZ.
-- It deliberately creates NO authorization or coverage decision. Ingestion
-- stays blocked until the database owner approves each source and verifies
-- coverage per market. No schedule, extension or outbound request.

begin;

do language plpgsql '
begin
  if to_regclass(''public.trend_sources'') is null or to_regclass(''public.trend_metric_definitions'') is null then
    raise exception ''0058 requires 0055_trend_intelligence'';
  end if;
  if not exists (select 1 from public.trend_sources where source_id = ''wikidata_events'') then
    raise exception ''0058 requires 0057_wikidata_event_source'';
  end if;
end';

insert into public.trend_sources
  (source_id, platforms, subject_kinds, language_scope, requires_evidence_url,
   max_retention_days, fresh_for, stale_after, expires_after)
values
  ('public_holidays_nager', array['web'], array['topic'], 'optional', true,
   60, interval '7 days', interval '21 days', interval '45 days'),
  ('wikimedia_pageviews', array['web'], array['topic'], 'optional', true,
   30, interval '2 days', interval '4 days', interval '10 days')
on conflict (source_id) do nothing;

insert into public.trend_metric_definitions
  (version_id, source_id, metric_key, unit, effective_from, effective_until, min_value, max_value, integer_only, required)
values
  ('wikimedia_pageviews.daily_views.v1', 'wikimedia_pageviews', 'daily_views', 'count', null, null, 0, null, true, true)
on conflict (version_id) do nothing;

-- Re-application is harmless only when the rows are exactly ours. Never
-- mutate an unexpected definition that happens to use the same identifier.
do language plpgsql '
begin
  if not exists (
    select 1 from public.trend_sources
     where source_id = ''public_holidays_nager'' and platforms = array[''web''] and subject_kinds = array[''topic'']
       and language_scope = ''optional'' and requires_evidence_url and max_retention_days = 60
       and fresh_for = interval ''7 days'' and stale_after = interval ''21 days'' and expires_after = interval ''45 days''
  ) then
    raise exception ''0058 found a conflicting public_holidays_nager source definition'';
  end if;
  if not exists (
    select 1 from public.trend_sources
     where source_id = ''wikimedia_pageviews'' and platforms = array[''web''] and subject_kinds = array[''topic'']
       and language_scope = ''optional'' and requires_evidence_url and max_retention_days = 30
       and fresh_for = interval ''2 days'' and stale_after = interval ''4 days'' and expires_after = interval ''10 days''
  ) then
    raise exception ''0058 found a conflicting wikimedia_pageviews source definition'';
  end if;
  if not exists (
    select 1 from public.trend_metric_definitions
     where version_id = ''wikimedia_pageviews.daily_views.v1'' and source_id = ''wikimedia_pageviews''
       and metric_key = ''daily_views'' and unit = ''count'' and effective_from is null and effective_until is null
       and min_value = 0 and max_value is null and integer_only and required
  ) then
    raise exception ''0058 found a conflicting wikimedia_pageviews metric definition'';
  end if;
end';

commit;
