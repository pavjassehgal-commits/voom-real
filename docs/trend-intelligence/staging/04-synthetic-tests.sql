-- Trend Intelligence — STAGING SYNTHETIC TESTS (SELF-ROLLING-BACK).
--
-- Runs every database-side check in ONE transaction that ends in ROLLBACK:
-- nothing it creates (decisions, observations, audit rows, purge records,
-- temporary test trigger) survives. Synthetic data only: fake video ids
-- 'stgtest00NN', attribution 'STAGING-TEST'. No customer data, no provider.
--
-- Expected: the final row reads 'ALL TREND STAGING SYNTHETIC CHECKS PASSED'.
-- Any failed check raises an error naming it; the transaction is then
-- aborted and nothing is kept either way.
--
-- Requires: 0055_trend_intelligence.sql applied, and 03-verify.sql all ok
-- (in particular: no approvals exist yet). Run as the project owner (postgres).

begin;

do $staging$
declare
  t timestamptz := now() - interval '1 hour';
  base jsonb;
  r jsonb;
  first_id uuid;
  in_id uuid;
  fixed_id uuid;
  seeded uuid;
  page jsonb;
  ids text[];
  n integer;
begin
  -- Preconditions: a clean trend schema.
  assert (select count(*) from public.trend_source_authorizations) = 0, 'precondition: no approvals may exist';
  assert (select count(*) from public.trend_observations) = 0, 'precondition: no observations may exist';

  -- 1. Browser roles are denied everything.
  begin
    set local role anon;
    perform 1 from public.trend_observations limit 1;
    raise exception 'FAILED: anon can read trend_observations';
  exception when insufficient_privilege then null;
  end;
  begin
    set local role authenticated;
    perform public.trend_list_usable_observations('youtube', 'AE');
    raise exception 'FAILED: authenticated can execute the read RPC';
  exception when insufficient_privilege then null;
  end;
  begin
    set local role anon;
    perform public.trend_store_observation('{}'::jsonb, null);
    raise exception 'FAILED: anon can execute the store RPC';
  exception when insufficient_privilege then null;
  end;
  reset role;

  -- 2. service_role cannot write tables directly or invalidate.
  begin
    set local role service_role;
    insert into public.trend_source_authorizations (source_id, status, decided_at, decided_by, reference)
    values ('youtube_data_api', 'approved', now(), 'x', 'y');
    raise exception 'FAILED: service_role can approve a source';
  exception when insufficient_privilege then null;
  end;
  begin
    set local role service_role;
    perform public.trend_invalidate_observation(gen_random_uuid(), 'wrong_item', 'staff:x', 'T-1');
    raise exception 'FAILED: service_role can invalidate (corrections must be disabled)';
  exception when insufficient_privilege then null;
  end;
  reset role;

  -- 3. Deny by default: no approval yet.
  base := jsonb_build_object(
    'source_id', 'youtube_data_api', 'platform', 'youtube', 'country', 'AE', 'language', 'und',
    'subject_kind', 'video', 'subject_text', 'STAGING-TEST video', 'subject_normalized', 'staging-test video',
    'provider_item_id', 'stgtest0001', 'window_start', t, 'window_end', t, 'retrieved_at', t,
    'metrics', jsonb_build_object(
      'chart_rank', jsonb_build_object('status', 'measured', 'value', '1', 'definition_version', 'youtube_data_api.chart_rank.v1'),
      'view_count', jsonb_build_object('status', 'measured', 'value', '18446744073709551615', 'definition_version', 'youtube_data_api.view_count.v2'),
      'like_count', jsonb_build_object('status', 'unavailable', 'unavailable_reason', 'not_collected'),
      'comment_count', jsonb_build_object('status', 'unavailable', 'unavailable_reason', 'hidden_by_owner')),
    'evidence', jsonb_build_array(jsonb_build_object('source_id', 'youtube_data_api', 'url', null, 'attribution', 'STAGING-TEST', 'retrieved_at', t)));
  set local role service_role;
  r := public.trend_store_observation(base, null);
  reset role;
  assert r ->> 'code' = 'source_not_authorized', 'FAILED deny-by-default: ' || r::text;

  -- 4. Owner decisions (synthetic), recorded in the audit trail.
  insert into public.trend_source_authorizations (source_id, status, decided_at, decided_by, reference)
  values ('youtube_data_api', 'approved', now() - interval '10 minutes', 'owner:staging-test', 'STAGING-TEST-APPROVE');
  insert into public.trend_source_coverage (source_id, platform, country, status, checked_at, evidence, checked_by) values
    ('youtube_data_api', 'youtube', 'AE', 'verified', now() - interval '10 minutes', 'STAGING-TEST', 'owner:staging-test'),
    ('youtube_data_api', 'youtube', 'IN', 'verified', now() - interval '10 minutes', 'STAGING-TEST', 'owner:staging-test');
  assert (select count(*) from public.trend_audit_events where actor = 'owner:staging-test') = 3, 'FAILED audit: decisions not recorded';

  -- 5. Store, duplicate, conflict; atomic rows; exact precision; unavailable stays null.
  set local role service_role;
  r := public.trend_store_observation(base, null);
  reset role;
  assert r ->> 'status' = 'stored', 'FAILED store: ' || r::text;
  first_id := (r ->> 'observation_id')::uuid;
  assert (select count(*) from public.trend_observation_metrics where observation_id = first_id) = 4, 'FAILED atomic metrics';
  assert (select count(*) from public.trend_evidence where observation_id = first_id) = 1, 'FAILED atomic evidence';
  assert (select value::text from public.trend_observation_metrics where observation_id = first_id and metric_key = 'view_count')
         = '18446744073709551615', 'FAILED precision';
  assert (select value from public.trend_observation_metrics where observation_id = first_id and metric_key = 'like_count') is null,
         'FAILED unavailable metric became a value';
  -- The RPC holds share locks on the decisions it relied on until commit.
  assert (select count(*) from pg_catalog.pg_locks l where l.locktype = 'relation' and l.mode = 'RowShareLock'
           and l.relation in ('public.trend_source_authorizations'::regclass, 'public.trend_source_coverage'::regclass)
           and l.pid = pg_backend_pid()) = 2, 'FAILED revocation lock not taken';
  set local role service_role;
  r := public.trend_store_observation(base, null);
  assert r ->> 'status' = 'duplicate', 'FAILED duplicate: ' || r::text;
  r := public.trend_store_observation(base || jsonb_build_object('subject_text', 'STAGING-TEST changed'), null);
  assert r ->> 'status' = 'conflict', 'FAILED conflict: ' || r::text;
  r := public.trend_store_observation(base || jsonb_build_object('delete_after', '2099-01-01T00:00:00Z'), null);
  assert r ->> 'code' = 'invalid_payload', 'FAILED payload allowlist: ' || r::text;
  reset role;
  assert (select subject_text from public.trend_observations where id = first_id) = 'STAGING-TEST video', 'FAILED conflict overwrote data';
  assert (select delete_after from public.trend_observations where id = first_id) = t + interval '7 days', 'FAILED retention deadline';

  -- 6. Country isolation and missing / expired coverage.
  set local role service_role;
  r := public.trend_store_observation(base || jsonb_build_object('country', 'IN'), null);
  assert r ->> 'status' = 'stored', 'FAILED IN store: ' || r::text;
  in_id := (r ->> 'observation_id')::uuid;
  r := public.trend_store_observation(base || jsonb_build_object('country', 'SG', 'provider_item_id', 'stgtest0002'), null);
  assert r ->> 'code' = 'coverage_not_verified', 'FAILED missing coverage: ' || r::text;
  reset role;
  update public.trend_source_coverage set checked_at = now() - interval '181 days'
   where source_id = 'youtube_data_api' and country = 'IN';
  set local role service_role;
  r := public.trend_store_observation(base || jsonb_build_object('country', 'IN', 'provider_item_id', 'stgtest0003'), null);
  assert r ->> 'code' = 'coverage_not_verified', 'FAILED expired coverage: ' || r::text;
  page := public.trend_list_usable_observations('youtube', 'IN', null, 200, null, null);
  assert jsonb_array_length(page -> 'observations') = 0, 'FAILED expired coverage still readable';
  page := public.trend_list_usable_observations('youtube', 'AE', null, 200, null, null);
  select array_agg(o ->> 'storage_id') into ids from jsonb_array_elements(page -> 'observations') o;
  assert first_id::text = any (ids) and not (in_id::text = any (ids)), 'FAILED country isolation in reads';
  assert (page -> 'observations' -> 0 -> 'metrics' -> 'view_count' ->> 'value') = '18446744073709551615', 'FAILED read precision';
  reset role;

  -- 7. Revocation hides data and blocks writes; expired approval likewise; re-approval restores.
  update public.trend_source_authorizations set status = 'not_approved', decided_at = now() - interval '5 minutes',
         reference = 'STAGING-TEST-REVOKE' where source_id = 'youtube_data_api';
  set local role service_role;
  r := public.trend_store_observation(base || jsonb_build_object('provider_item_id', 'stgtest0004'), null);
  assert r ->> 'code' = 'source_not_authorized', 'FAILED revocation blocks writes: ' || r::text;
  page := public.trend_list_usable_observations('youtube', 'AE', null, 200, null, null);
  assert jsonb_array_length(page -> 'observations') = 0, 'FAILED revocation hides reads';
  reset role;
  update public.trend_source_authorizations set status = 'approved', decided_at = now() - interval '366 days',
         reference = 'STAGING-TEST-OLD' where source_id = 'youtube_data_api';
  set local role service_role;
  r := public.trend_store_observation(base || jsonb_build_object('provider_item_id', 'stgtest0005'), null);
  assert r ->> 'code' = 'source_not_authorized', 'FAILED expired approval: ' || r::text;
  reset role;
  update public.trend_source_authorizations set status = 'approved', decided_at = now() - interval '4 minutes',
         reference = 'STAGING-TEST-REAPPROVE' where source_id = 'youtube_data_api';
  begin
    update public.trend_source_authorizations set reference = 'STAGING-TEST-SILENT' where source_id = 'youtube_data_api';
    raise exception 'FAILED: decision changed without a new timestamp';
  exception when raise_exception then
    if sqlerrm <> 'trend_decision_needs_new_timestamp' then raise; end if;
  end;
  assert (select count(*) from public.trend_audit_events where source_id = 'youtube_data_api' and event_type = 'authorization_changed') = 3,
         'FAILED audit of approval changes';

  -- 8. Corrections: owner-only invalidation, replacement as revision 2, no resurrection.
  r := public.trend_invalidate_observation(first_id, 'wrong_evidence', 'staff:staging-test', 'STAGING-TEST-CORRECT');
  assert r ->> 'status' = 'invalidated', 'FAILED invalidate: ' || r::text;
  set local role service_role;
  page := public.trend_list_usable_observations('youtube', 'AE', null, 200, null, null);
  assert jsonb_array_length(page -> 'observations') = 0, 'FAILED invalidated row still readable';
  r := public.trend_store_observation(base, null);
  assert r ->> 'status' = 'invalidated', 'FAILED plain replay resurrected: ' || r::text;
  r := public.trend_store_observation(base || jsonb_build_object('evidence', jsonb_build_array(jsonb_build_object(
         'source_id', 'youtube_data_api', 'url', 'https://www.youtube.com/watch?v=stgtest0001', 'attribution', 'STAGING-TEST', 'retrieved_at', t))), first_id);
  assert r ->> 'status' = 'stored' and (r ->> 'revision')::int = 2, 'FAILED replacement: ' || r::text;
  fixed_id := (r ->> 'observation_id')::uuid;
  page := public.trend_list_usable_observations('youtube', 'AE', null, 200, null, null);
  assert page -> 'observations' -> 0 ->> 'storage_id' = fixed_id::text, 'FAILED replacement not served';
  reset role;
  assert (select count(*) from public.trend_evidence where observation_id = first_id) = 1, 'FAILED history lost';
  assert (select count(*) from public.trend_audit_events where event_type = 'observation_invalidated' and observation_id = first_id
           and next::text not like '%stgtest%' and coalesce(reference, '') not like '%youtube%') = 1, 'FAILED invalidation audit (no content)';

  -- 9. Pagination is bounded and complete.
  set local role service_role;
  for n in 10..14 loop
    r := public.trend_store_observation(base || jsonb_build_object('provider_item_id', 'stgtest00' || n,
           'window_start', t - make_interval(mins => n), 'window_end', t - make_interval(mins => n)), null);
    assert r ->> 'status' = 'stored', 'FAILED page seed: ' || r::text;
  end loop;
  page := public.trend_list_usable_observations('youtube', 'AE', null, 4, null, null);
  assert jsonb_array_length(page -> 'observations') = 4 and page -> 'next_cursor' is not null and page -> 'next_cursor' <> 'null'::jsonb, 'FAILED page 1';
  page := public.trend_list_usable_observations('youtube', 'AE', null, 4,
            (page -> 'next_cursor' ->> 'window_end')::timestamptz, (page -> 'next_cursor' ->> 'id')::uuid);
  assert jsonb_array_length(page -> 'observations') = 2 and (page -> 'next_cursor' = 'null'::jsonb or page -> 'next_cursor' is null), 'FAILED page 2';
  assert public.trend_list_usable_observations('youtube', 'AE', null, 5000, null, null) ->> 'reason' = 'invalid_limit', 'FAILED limit bound';
  reset role;

  -- 10. Retention: seed one overdue row (owner fixture path), purge it, health clears.
  alter table public.trend_observations disable trigger trend_observations_guard_insert;
  insert into public.trend_observations (source_id, platform, country, language, subject_kind, subject_text, subject_normalized,
    provider_item_id, window_start, window_end, retrieved_at, fresh_until, stale_after, expires_at, freshness_basis, delete_after)
  values ('youtube_data_api', 'youtube', 'AE', 'und', 'video', 'STAGING-TEST overdue', 'staging-test overdue', 'stgtest0099',
    now() - interval '40 days', now() - interval '40 days', now() - interval '40 days', now() - interval '40 days',
    now() - interval '40 days', now() - interval '33 days', 'provisional_product_default', now() - interval '3 days')
  returning id into seeded;
  insert into public.trend_observation_metrics (observation_id, metric_key, status, value, unit, definition_version) values
    (seeded, 'chart_rank', 'measured', 1, 'rank', 'youtube_data_api.chart_rank.v1'),
    (seeded, 'view_count', 'measured', 1, 'count', 'youtube_data_api.view_count.v2');
  insert into public.trend_evidence (observation_id, source_id, attribution, url, retrieved_at)
  values (seeded, 'youtube_data_api', 'STAGING-TEST', null, now() - interval '40 days');
  set constraints all immediate;
  alter table public.trend_observations enable trigger trend_observations_guard_insert;

  set local role service_role;
  r := public.trend_retention_status();
  assert (r ->> 'breach')::boolean and (r ->> 'youtube_policy_breach')::boolean, 'FAILED breach not reported: ' || r::text;
  r := public.trend_run_retention_purge(1000);
  assert r ->> 'status' = 'succeeded' and (r ->> 'observations_deleted')::int = 1 and (r ->> 'remaining_overdue')::int = 0,
         'FAILED purge: ' || r::text;
  r := public.trend_retention_status();
  assert not (r ->> 'breach')::boolean, 'FAILED breach not cleared: ' || r::text;
  reset role;
  assert not exists (select 1 from public.trend_evidence where observation_id = seeded), 'FAILED purge cascade';
  begin
    delete from public.trend_observations where id = fixed_id;
    raise exception 'FAILED: direct delete allowed';
  exception when raise_exception then
    if sqlerrm <> 'trend_delete_only_by_purge' then raise; end if;
  end;
  assert (select count(*) from public.trend_purge_runs where status = 'succeeded') >= 1, 'FAILED purge run not recorded';

  raise notice 'all trend staging synthetic checks passed';
end
$staging$;

select 'ALL TREND STAGING SYNTHETIC CHECKS PASSED' as result;

rollback;
