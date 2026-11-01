-- VOOM YouTube compliance — post-apply FINGERPRINT (after 0065, and again after 0069). READ-ONLY: one SELECT.
-- Compare with: node scripts/youtube-register/verify-fingerprint.mjs 0065|0069 <pasted.json>
select jsonb_pretty((
  with fn as (
    select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig,
      md5(p.prosrc) as src, p.prosecdef as secdef, coalesce(array_to_string(p.proconfig, ','), '') as cfg,
      coalesce((select string_agg(case when a.grantee = 0 then 'PUBLIC' else r.rolname end, ',' order by 1)
        from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        left join pg_roles r on r.oid = a.grantee
        where a.privilege_type = 'EXECUTE' and a.grantee <> p.proowner
          and (a.grantee = 0 or r.rolname in ('anon', 'authenticated', 'service_role'))), '') as exec
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'request_youtube_erasure', 'erase_youtube_data', 'youtube_publish_queue_guard', 'youtube_erasure_write_guard',
      'save_youtube_connection', 'save_youtube_connection_internal', 'disconnect_youtube_connection',
      'set_youtube_connection_status', 'youtube_before_account_delete', 'complete_youtube_publish_job',
      'update_youtube_access_token', 'update_youtube_access_token_internal', 'claim_youtube_revocation_tasks',
      'finish_youtube_revocation', 'prune_youtube_api_data', 'youtube_privacy_backlog',
      'erase_youtube_data_pre_delivery', 'request_youtube_erasure_pre_delivery', 'prepare_youtube_deletion_events',
      'claim_youtube_deletion_events', 'finish_youtube_deletion_event', 'flag_youtube_deletion_failure')
  ), tbl as (
    select c.relname as t, c.relrowsecurity as rls, c.relforcerowsecurity as force_rls,
      (select string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text || ':' ||
          coalesce(md5(pg_get_expr(d.adbin, d.adrelid)), ''), ',' order by a.attnum)
        from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
          and (c.relname <> 'youtube_connections' or a.attname like 'authorization%')) as cols,
      (select string_agg(md5(pg_get_constraintdef(k.oid)), ',' order by md5(pg_get_constraintdef(k.oid))) from pg_constraint k where k.conrelid = c.oid
        and k.contype <> 'n' and c.relname <> 'youtube_connections') as cons,
      (select count(*) from pg_policy pl where pl.polrelid = c.oid) as policies,
      (select string_agg(r.rolname || '=' || concat_ws('',
          case when has_table_privilege(r.oid, c.oid, 'SELECT') then 's' end,
          case when has_table_privilege(r.oid, c.oid, 'INSERT') then 'i' end,
          case when has_table_privilege(r.oid, c.oid, 'UPDATE') then 'u' end,
          case when has_table_privilege(r.oid, c.oid, 'DELETE') then 'd' end), ',' order by r.rolname)
        from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role')) as privs
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relname in
      ('youtube_privacy_controls', 'youtube_erased_publications', 'youtube_revocation_tasks', 'youtube_deletion_events', 'youtube_connections')
  ), idx as (
    select i.relname as name, md5(pg_get_indexdef(i.oid)) as def
    from pg_index x join pg_class i on i.oid = x.indexrelid join pg_class c on c.oid = x.indrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and (c.relname in ('youtube_privacy_controls', 'youtube_erased_publications', 'youtube_revocation_tasks', 'youtube_deletion_events')
      or i.relname = 'youtube_authorization_check_due')
  ), trg as (
    select t.tgname as name, c.relname as tbl, p.proname as fn, t.tgenabled::text as enabled
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
    where not t.tgisinternal and t.tgname in ('youtube_queue_erasure_guard', 'youtube_snapshot_erasure_guard',
      'youtube_connection_erasure_guard', 'youtube_secret_erasure_guard', 'youtube_account_delete')
  )
  select jsonb_build_object(
    'functions', (select coalesce(jsonb_object_agg(sig, jsonb_build_object('src', src, 'secdef', secdef, 'cfg', cfg, 'exec', exec)), '{}'::jsonb) from fn),
    'tables', (select coalesce(jsonb_object_agg(t, jsonb_build_object('rls', rls, 'force_rls', force_rls, 'cols', md5(cols), 'cons', md5(coalesce(cons, '')), 'policies', policies, 'privs', privs)), '{}'::jsonb) from tbl),
    'indexes', (select coalesce(jsonb_object_agg(name, def), '{}'::jsonb) from idx),
    'triggers', (select coalesce(jsonb_object_agg(name, tbl || ':' || fn || ':' || enabled), '{}'::jsonb) from trg)
  ) as fingerprint
)) as youtube_compliance_fingerprint;
