-- Deletes only the 0057 source row. This intentionally fails rather than
-- cascading if any authorization, coverage or observation row depends on it;
-- those reviewed records must be handled explicitly before rollback.
begin;
do language plpgsql '
begin
  if exists (select 1 from public.trend_sources where source_id = ''wikidata_events'')
     and not exists (
       select 1 from public.trend_sources
        where source_id = ''wikidata_events''
          and platforms = array[''web''] and subject_kinds = array[''topic'']
          and language_scope = ''optional'' and requires_evidence_url
          and max_retention_days = 30 and fresh_for = interval ''1 day''
          and stale_after = interval ''3 days'' and expires_after = interval ''14 days''
     ) then
    raise exception ''0057 rollback refuses a conflicting wikidata_events definition'';
  end if;
end';
delete from public.trend_sources where source_id = 'wikidata_events';
commit;
