-- Rollback for 0058_universal_trend_sources.sql. Refuses while any stored
-- observation, authorization or coverage record still uses the new sources.
begin;

do language plpgsql '
begin
  if exists (select 1 from public.trend_observations where source_id in (''public_holidays_nager'', ''wikimedia_pageviews''))
     or exists (select 1 from public.trend_source_authorizations where source_id in (''public_holidays_nager'', ''wikimedia_pageviews''))
     or exists (select 1 from public.trend_source_coverage where source_id in (''public_holidays_nager'', ''wikimedia_pageviews'')) then
    raise exception ''0058 rollback refused: the new sources are still referenced'';
  end if;
end';

delete from public.trend_metric_definitions where version_id = 'wikimedia_pageviews.daily_views.v1';
delete from public.trend_sources where source_id in ('public_holidays_nager', 'wikimedia_pageviews');

commit;
