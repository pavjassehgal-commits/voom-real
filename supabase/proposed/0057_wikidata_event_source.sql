-- 0057_wikidata_event_source.sql — proposed source-registry addition only.
-- Adds the free CC0 Wikidata event connector to the existing 0055 registry.
-- It deliberately creates NO authorization or coverage decision: ingestion
-- remains blocked until the database owner records reviewed approval and
-- verifies AE/web coverage. No schedule, extension or outbound request.

begin;

do language plpgsql '
begin
  if to_regclass(''public.trend_sources'') is null then
    raise exception ''0057 requires 0055_trend_intelligence'';
  end if;
  if (select count(*) from information_schema.columns
      where table_schema = ''public'' and table_name = ''trend_sources''
        and column_name in (''fresh_for'', ''stale_after'', ''expires_after'')) <> 3 then
    raise exception ''0057 requires the complete governed 0055 schema'';
  end if;
end';

insert into public.trend_sources
  (source_id, platforms, subject_kinds, language_scope, requires_evidence_url,
   max_retention_days, fresh_for, stale_after, expires_after)
values
  ('wikidata_events', array['web'], array['topic'], 'optional', true,
   30, interval '1 day', interval '3 days', interval '14 days')
on conflict (source_id) do nothing;

-- Re-application is harmless only when the row is exactly ours. Never mutate
-- an unexpected source definition that happens to use the same identifier.
do language plpgsql '
begin
  if not exists (
    select 1 from public.trend_sources
     where source_id = ''wikidata_events''
       and platforms = array[''web'']
       and subject_kinds = array[''topic'']
       and language_scope = ''optional''
       and requires_evidence_url
       and max_retention_days = 30
       and fresh_for = interval ''1 day''
       and stale_after = interval ''3 days''
       and expires_after = interval ''14 days''
  ) then
    raise exception ''0057 found a conflicting wikidata_events source definition'';
  end if;
end';

commit;
