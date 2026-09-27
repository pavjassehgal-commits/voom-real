-- Voom production worker schedule (Supabase Cron → voom.today).
--
-- NOT a migration: run this once in the Supabase SQL editor of the PRODUCTION
-- project after the app is live on https://voom.today. It is idempotent —
-- re-running replaces the jobs with the same names.
--
-- Prerequisites
--   1. Database → Extensions: enable `pg_cron` and `pg_net`.
--   2. Store the SAME value you set as CRON_SECRET in Vercel in Vault:
--        select vault.create_secret('<CRON_SECRET>', 'voom_cron_secret');
--      (to rotate: select vault.update_secret(id, '<new>') ... ; then update
--       CRON_SECRET in Vercel and redeploy.)
--   3. If you ever change the domain, edit v_base below and re-run.
--
-- The daily planning job (/api/cron/weekly-plans) stays in vercel.json.
-- Every route below fails closed: 503 without CRON_SECRET, 401 on mismatch.

create extension if not exists pg_cron;
create extension if not exists pg_net;

create schema if not exists voom_ops;
revoke all on schema voom_ops from public, anon, authenticated;

-- Calls one worker route with the Bearer secret read from Vault at run time,
-- so the secret never appears in cron.job or in this file.
create or replace function voom_ops.call_worker(p_path text)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_base constant text := 'https://voom.today';
  v_secret text;
begin
  select decrypted_secret into v_secret
    from vault.decrypted_secrets
   where name = 'voom_cron_secret'
   limit 1;
  if v_secret is null then
    raise exception 'voom_cron_secret is missing from Vault';
  end if;
  return net.http_get(
    url := v_base || p_path,
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret),
    timeout_milliseconds := 290000
  );
end;
$$;

revoke all on function voom_ops.call_worker(text) from public, anon, authenticated;

-- Remove any previous copies of these jobs before (re)creating them.
do $$
declare
  v_name text;
begin
  foreach v_name in array array[
    'voom-instagram-publish-5m',
    'voom-media-generation-2m',
    'voom-email-flows-15m',
    'voom-instagram-performance-6h',
    'voom-youtube-publish-5m',
    'voom-youtube-reconcile-10m',
    'voom-youtube-performance-1h',
    'voom-tiktok-publish-5m',
    'voom-tiktok-reconcile-10m'
  ] loop
    if exists (select 1 from cron.job where jobname = v_name) then
      perform cron.unschedule(v_name);
    end if;
  end loop;
end;
$$;

-- Publishing (claimed atomically in Postgres; overlapping runs are safe).
select cron.schedule('voom-instagram-publish-5m',   '*/5 * * * *',  $$select voom_ops.call_worker('/api/cron/instagram-publish')$$);
select cron.schedule('voom-youtube-publish-5m',     '1-59/5 * * * *', $$select voom_ops.call_worker('/api/cron/youtube-publish')$$);
select cron.schedule('voom-tiktok-publish-5m',      '2-59/5 * * * *', $$select voom_ops.call_worker('/api/cron/tiktok-publish')$$);

-- Provider outcome reconciliation.
select cron.schedule('voom-youtube-reconcile-10m',  '3-59/10 * * * *', $$select voom_ops.call_worker('/api/cron/youtube-reconcile')$$);
select cron.schedule('voom-tiktok-reconcile-10m',   '4-59/10 * * * *', $$select voom_ops.call_worker('/api/cron/tiktok-reconcile')$$);

-- Async video generation polling (README: every 2 minutes).
select cron.schedule('voom-media-generation-2m',    '*/2 * * * *',  $$select voom_ops.call_worker('/api/cron/media-generation')$$);

-- Lifecycle email flows (README: every 15 minutes; matches EMAIL_FLOW_CRON_CADENCE_MINUTES).
select cron.schedule('voom-email-flows-15m',        '*/15 * * * *', $$select voom_ops.call_worker('/api/cron/email-flows')$$);

-- Read-only performance collectors.
select cron.schedule('voom-instagram-performance-6h', '17 */6 * * *', $$select voom_ops.call_worker('/api/cron/instagram-performance')$$);
select cron.schedule('voom-youtube-performance-1h',   '23 * * * *',   $$select voom_ops.call_worker('/api/cron/youtube-performance')$$);

-- Check:   select jobname, schedule, active from cron.job where jobname like 'voom-%' order by jobname;
-- History: select j.jobname, d.status, d.start_time, d.return_message
--            from cron.job_run_details d join cron.job j using (jobid)
--           where j.jobname like 'voom-%' order by d.start_time desc limit 50;
-- HTTP results: select id, status_code, left(content::text, 200), created
--                 from net._http_response order by created desc limit 20;
