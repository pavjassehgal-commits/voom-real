-- VOOM YouTube compliance (0065 + 0069) — Production PREFLIGHT. READ-ONLY: one SELECT.
-- Run in the Supabase SQL editor of the target project BEFORE applying 0065.
-- Output: booleans, names and counts only (no customer content, ids, tokens or emails).
select jsonb_pretty(jsonb_build_object(
  'database', current_database(),
  'checked_at', now(),
  'pg_version', current_setting('server_version_num'),
  'ledger_tail', (select case when to_regclass('supabase_migrations.schema_migrations') is null then 'absent'
     else (xpath('/row/v/text()', query_to_xml($q$select coalesce(string_agg(version, ',' order by version), '') v
       from supabase_migrations.schema_migrations where version >= '0060'$q$, false, true, '')))[1]::text end),
  -- Must all be false: neither migration is partially installed.
  'already_installed', jsonb_build_object(
    'privacy_controls', to_regclass('public.youtube_privacy_controls') is not null,
    'erased_publications', to_regclass('public.youtube_erased_publications') is not null,
    'revocation_tasks', to_regclass('public.youtube_revocation_tasks') is not null,
    'authorization_epoch_column', exists (select 1 from information_schema.columns where table_schema = 'public'
      and table_name = 'youtube_connections' and column_name in ('authorization_epoch', 'authorization_checked_at')),
    'save_internal', to_regprocedure('public.save_youtube_connection_internal(uuid,text,text,text,text,text[],text,text,text,smallint,text,text,text,smallint,timestamptz)') is not null,
    'update_internal', to_regprocedure('public.update_youtube_access_token_internal(uuid,text,text,text,smallint,timestamptz)') is not null,
    'erasure_triggers', (select count(*) from pg_trigger where tgname in ('youtube_queue_erasure_guard', 'youtube_snapshot_erasure_guard',
      'youtube_connection_erasure_guard', 'youtube_secret_erasure_guard', 'youtube_account_delete')),
    'deletion_events_0069', to_regclass('public.youtube_deletion_events') is not null),
  -- Must all be true: objects 0065 renames/replaces and its foreign keys exist as reviewed.
  'prerequisites', jsonb_build_object(
    'save_connection_15_args', to_regprocedure('public.save_youtube_connection(uuid,text,text,text,text,text[],text,text,text,smallint,text,text,text,smallint,timestamptz)') is not null,
    'update_token_6_args', to_regprocedure('public.update_youtube_access_token(uuid,text,text,text,smallint,timestamptz)') is not null,
    'disconnect_fn', to_regprocedure('public.disconnect_youtube_connection(uuid)') is not null,
    'set_status_fn', to_regprocedure('public.set_youtube_connection_status(uuid,text)') is not null,
    'complete_job_fn', to_regprocedure('public.complete_youtube_publish_job(uuid,uuid,text,text,text)') is not null,
    'queue_guard_fn', to_regprocedure('public.youtube_publish_queue_guard()') is not null,
    'drafts_id_owner_unique', exists (select 1 from pg_constraint k join pg_class c on c.oid = k.conrelid
      where c.relname = 'mara_drafts' and k.contype in ('u', 'p') and pg_get_constraintdef(k.oid) ~ '\(id, owner_user_id\)'),
    'tables', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'
      and c.relname in ('youtube_connections', 'youtube_connection_secrets', 'youtube_oauth_states', 'youtube_publish_queue', 'youtube_performance_snapshots')),
    'present_0066', to_regclass('public.youtube_upload_sessions') is not null,
    'present_0070', to_regclass('public.plan_slot_generation_leases') is not null,
    'present_0071', exists (select 1 from pg_trigger where tgname = 'ensure_business_automation_mode_entitled'),
    'present_0072', exists (select 1 from pg_trigger where tgname = 'ensure_coordinator_email_flow_authorized'),
    'roles', (select count(*) from pg_roles where rolname in ('anon', 'authenticated', 'service_role'))),
  -- What the first maintenance run will act on. Connections are re-verified with Google
  -- first; only unverifiable ones (and evidence older than 28 days) are removed.
  'baseline', jsonb_build_object(
    'connections_by_status', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (select status, count(*) n from public.youtube_connections group by status) x),
    'connected_older_than_28d', (select count(*) from public.youtube_connections where status = 'connected' and connected_at < now() - interval '28 days'),
    'not_connected_rows', (select count(*) from public.youtube_connections where status <> 'connected'),
    'secrets', (select count(*) from public.youtube_connection_secrets),
    'queue_by_status', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (select status, count(*) n from public.youtube_publish_queue group by status) x),
    'provider_evidence_older_than_28d', (select count(*) from public.youtube_publish_queue where (youtube_video_id is not null or upload_session_url is not null)
      and coalesce(last_provider_check_at, last_attempt_at, created_at) < now() - interval '28 days'),
    'in_flight_uploads', (select count(*) from public.youtube_publish_queue where status in ('uploading', 'provider_processing')),
    'snapshots', (select count(*) from public.youtube_performance_snapshots),
    'snapshots_older_than_28d', (select count(*) from public.youtube_performance_snapshots where collected_at < now() - interval '28 days'),
    'oauth_states', (select count(*) from public.youtube_oauth_states),
    'upload_sessions', (select case when to_regclass('public.youtube_upload_sessions') is null then null
      else (xpath('/row/n/text()', query_to_xml('select count(*) n from public.youtube_upload_sessions', false, true, '')))[1]::text::int end),
    'auth_users', (select count(*) from auth.users),
    'youtube_cron_jobs', (select coalesce(jsonb_agg(jsonb_build_object('name', jobname, 'schedule', schedule, 'active', active) order by jobname), '[]'::jsonb)
      from cron.job where jobname like '%youtube%')),
  'locks_on_youtube_tables', (select count(*) from pg_locks l join pg_class c on c.oid = l.relation where c.relname like 'youtube_%' and not l.granted)
)) as youtube_compliance_preflight;
