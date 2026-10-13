-- Trend Intelligence — STAGING: committed synthetic decisions for step 05
-- (PostgREST role checks and real concurrent requests). Labelled
-- STAGING-TEST; removed by 06-cleanup.sql. One source, one market only.

begin;

insert into public.trend_source_authorizations (source_id, status, decided_at, decided_by, reference)
values ('youtube_data_api', 'approved', now() - interval '1 minute', 'owner:staging-test', 'STAGING-TEST-APPROVE');

insert into public.trend_source_coverage (source_id, platform, country, status, checked_at, evidence, checked_by)
values ('youtube_data_api', 'youtube', 'AE', 'verified', now() - interval '1 minute', 'STAGING-TEST', 'owner:staging-test');

select source_id, status, reference from public.trend_source_authorizations;

commit;
