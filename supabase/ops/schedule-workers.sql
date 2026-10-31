-- Voom Production worker schedule. MANUAL OPS FILE, NOT A MIGRATION.
-- Separate approval + Production identity verification required before execution.
-- Existing secure jobs are NEVER rewritten/re-enabled/renamed. Missing jobs only
-- are created; conflicting names/routes/configuration abort the whole transaction.
-- See docs/scheduled-workers.md. No helper function or extension is installed.
-- Requires pg_cron, pg_net and exactly one nonempty Vault secret named
-- voom_instagram_cron_secret (the existing Production CRON_SECRET reference).
-- Do not paste/print the secret. pg_net's internal request queue contains headers:
-- keep database access restricted; Vault prevents literals in cron.job, not that queue.

begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $schedule$
declare
  worker record;
  existing record;
  parts text[];
  command text;
  count_jobs integer;
  -- Accept ONLY the verified direct POST/Vault shape, not arbitrary SQL with
  -- a trusted substring. Whitespace outside literals may vary; Bearer space matters.
  shape constant text := $shape$^\s*select\s+net\.http_post\(\s*url\s*:=\s*'([^']+)'\s*,\s*headers\s*:=\s*jsonb_build_object\(\s*'Authorization'\s*,\s*'Bearer '\s*\|\|\s*\(\s*select\s+decrypted_secret\s+from\s+vault\.decrypted_secrets\s+where\s+name\s*=\s*'voom_instagram_cron_secret'\s*\)\s*\)\s*,\s*body\s*:=\s*'\{\}'::jsonb\s*(?:,\s*timeout_milliseconds\s*:=\s*([0-9]+)\s*)?\)\s*;?\s*$$shape$;
begin
  if to_regclass('cron.job') is null or to_regclass('vault.decrypted_secrets') is null
    or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null
    or to_regprocedure('cron.schedule(text,text,text)') is null then
    raise exception 'Required pg_cron/pg_net/Vault objects are missing; no jobs changed';
  end if;
  if (select count(*) from vault.decrypted_secrets where name='voom_instagram_cron_secret')<>1
    or not exists(select 1 from vault.decrypted_secrets where name='voom_instagram_cron_secret'
      and decrypted_secret is not null and length(btrim(decrypted_secret))>0) then
    raise exception 'Required Vault reference is missing, empty or ambiguous; no jobs changed';
  end if;

  -- Serialize against other job creates/edits (including another run of this file).
  -- No HTTP call is executed here: the command below is stored text for pg_cron.
  lock table cron.job in share row exclusive mode;
  for worker in
    select * from (values
      -- BEGIN WORKER MANIFEST: existing Production names/timings, not old aliases.
      ('voom-instagram-publish-5m', '*/5 * * * *', '/api/cron/instagram-publish', 'https://voom-real.vercel.app', null::integer, false),
      ('voom-media-generation-2m', '*/2 * * * *', '/api/cron/media-generation', 'https://voom-real.vercel.app', null::integer, false),
      ('voom-instagram-performance-sync', '0 */6 * * *', '/api/cron/instagram-performance', 'https://voom-real.vercel.app', null::integer, false),
      ('voom-email-flows-15m', '*/15 * * * *', '/api/cron/email-flows', 'https://voom-real.vercel.app', 310000, false),
      ('voom-youtube-publish-5m', '*/5 * * * *', '/api/cron/youtube-publish', 'https://voom-real.vercel.app', null::integer, false),
      ('voom-youtube-reconcile-5m', '*/5 * * * *', '/api/cron/youtube-reconcile', 'https://voom-real.vercel.app', null::integer, false),
      ('voom-youtube-performance-hourly', '0 * * * *', '/api/cron/youtube-performance', 'https://voom-real.vercel.app', 310000, false),
      ('voom-tiktok-publish-5m', '*/5 * * * *', '/api/cron/tiktok-publish', 'https://voom-real.vercel.app', null::integer, false),
      ('voom-tiktok-reconcile-5m', '*/5 * * * *', '/api/cron/tiktok-reconcile', 'https://voom-real.vercel.app', null::integer, false),
      -- Renewal: retain the original repository's 290 s default for NEW installs.
      -- Its corrected live command is preserved, including its actual timeout.
      ('voom-instagram-token-refresh-6h', '41 */6 * * *', '/api/cron/instagram-token-refresh', 'https://voom.today', 290000, true)
      -- END WORKER MANIFEST
    ) as manifest(jobname, cadence, endpoint, base_url, timeout_ms, preserve_existing_timeout)
  loop
    select count(*) into count_jobs from cron.job where jobname=worker.jobname;
    if count_jobs>1 then raise exception 'Duplicate managed job name; no jobs changed'; end if;
    -- A differently named job already calling this route is NOT a missing job:
    -- stop rather than create a duplicate or silently replace an old alias.
    if exists(select 1 from cron.job where position(worker.endpoint in cron.job.command)>0
      and jobname is distinct from worker.jobname) then
      raise exception 'Worker route already scheduled under another name; no jobs changed';
    end if;
    if count_jobs=1 then
      select * into existing from cron.job where jobname=worker.jobname;
      parts:=regexp_match(existing.command,shape);
      if parts is null or existing.schedule<>worker.cadence or not existing.active
        or existing.database<>current_database() or existing.username<>current_user then
        raise exception 'Managed worker configuration differs; no jobs changed';
      end if;
      if parts[1] not in ('https://voom.today'||worker.endpoint,'https://voom-real.vercel.app'||worker.endpoint)
        or (not worker.preserve_existing_timeout and parts[2]::integer is distinct from worker.timeout_ms)
        or (worker.preserve_existing_timeout and parts[2] is not null and parts[2]::integer not between 1 and 310000) then
        raise exception 'Managed endpoint/timeout differs; no jobs changed';
      end if;
      -- NO cron.schedule on an existing name: no schedule/command/id/active changes.
      continue;
    end if;

    -- Explicit per-name approval is required even to create a MISSING job.
    -- Default reruns are validation-only when the managed jobs already exist.
    if not (worker.jobname=any(string_to_array(coalesce(current_setting('voom_ops.create_jobs',true),''),','))) then
      raise exception 'Missing managed job requires explicit per-name creation approval; no jobs changed';
    end if;
    command:=format($command$select net.http_post(
  url := %L,
  headers := jsonb_build_object('Authorization', 'Bearer ' ||
    (select decrypted_secret from vault.decrypted_secrets where name = 'voom_instagram_cron_secret')),
  body := '{}'::jsonb%s
);$command$,worker.base_url||worker.endpoint,
      case when worker.timeout_ms is null then '' else format(', timeout_milliseconds := %s',worker.timeout_ms) end);
    perform cron.schedule(worker.jobname,worker.cadence,command);
  end loop;
end;
$schedule$;
commit;

-- LinkedIn and daily planning/collection remain in vercel.json, not duplicated here.
-- Inspect only jobname/schedule/active and sanitized HTTP status/error metadata.
-- Do not dump Vault values or net.http_request_queue headers into logs or tickets.
