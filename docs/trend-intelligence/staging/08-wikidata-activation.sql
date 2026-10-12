-- PROPOSED, NOT APPLIED. voom-staging (qcdpegwjofrqnfudyrqq) ONLY.
-- Records the two owner decisions that let the Wikidata connector store
-- observations: source approval and AE/web coverage verification.
-- One transaction. Refuses unless 0057's exact source row exists and no
-- Wikidata decision exists yet. Both inserts are recorded in the audit trail.
-- Expiry is enforced by the database: approval 365 days after decided_at,
-- coverage 180 days after checked_at (trend_*_review_period()).

begin;

do language plpgsql '
begin
  if not exists (
    select 1 from public.trend_sources
     where source_id = ''wikidata_events'' and platforms = array[''web''] and subject_kinds = array[''topic'']
       and language_scope = ''optional'' and requires_evidence_url and max_retention_days = 30
       and fresh_for = interval ''1 day'' and stale_after = interval ''3 days'' and expires_after = interval ''14 days''
  ) then
    raise exception ''08 requires the exact 0057 wikidata_events source'';
  end if;
  if exists (select 1 from public.trend_source_authorizations where source_id = ''wikidata_events'')
     or exists (select 1 from public.trend_source_coverage where source_id = ''wikidata_events'') then
    raise exception ''08 refuses: a wikidata_events decision already exists'';
  end if;
end';

insert into public.trend_source_authorizations (source_id, status, decided_at, decided_by, reference)
values (
  'wikidata_events',
  'approved',
  now(),
  'owner:pavjassehgal-commits',
  'STAGING ONLY (voom-staging). Licence: Wikidata structured data is CC0 1.0; commercial reuse permitted; attribution not required '
  || '(https://www.wikidata.org/wiki/Wikidata:Licensing, checked 2026-10-12). Voom still attributes "Wikidata (CC0)" with entity links and uses no Wikimedia logos. '
  || 'Usage: Wikidata Query Service limits and Wikimedia User-Agent policy (https://www.mediawiki.org/wiki/Wikidata_Query_Service/User_Manual; '
  || 'https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy). Connector: one GET per run, max 25 rows, 15 s timeout, '
  || 'identifying User-Agent, no retries. Scope: dated UAE event records only; qualitative; no popularity metrics; human review before any MARA use. '
  || 'Review by ' || to_char(now() + public.trend_authorization_review_period(), 'YYYY-MM-DD') || ' (database-enforced).'
);

insert into public.trend_source_coverage (source_id, platform, country, status, checked_at, evidence, checked_by)
values (
  'wikidata_events',
  'web',
  'AE',
  'verified',
  '2026-10-12T16:09:00Z',
  'Checked 2026-10-12 16:00-16:09 UTC via the public Wikidata Query Service using the connector query (P17 = Q878 United Arab Emirates, '
  || 'P580 start time within the next 120 days, English labels, LIMIT 25): 2 dated UAE event records returned, Q136192068 '
  || '(2026 Judo Grand Slam Abu Dhabi) and Q115910679 (2026 Abu Dhabi Grand Prix), both with day-precision dates. PARTIAL coverage only: '
  || 'Wikidata lists only UAE events someone has recorded with a start date; it does not represent all UAE events or any trend popularity '
  || '(no Wikidata item found for Dubai Fitness Challenge 2026; events dated only with P585 are not read). Re-check by 2027-04-10 (database-enforced).',
  'reviewer:claude-trend-research'
);

-- Expected: wikidata_events | approved | <today> | verified | AE | web | 2026-10-12 16:09:00+00
select a.source_id, a.status as authorization, a.decided_at::date as decided_on, c.status as coverage, c.country, c.platform, c.checked_at
  from public.trend_source_authorizations a
  join public.trend_source_coverage c on c.source_id = a.source_id
 where a.source_id = 'wikidata_events';

commit;
