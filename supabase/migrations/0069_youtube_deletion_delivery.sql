-- Local-only forward migration. Requires 0065; never rewrites installed SQL.
-- No network, deletion, worker activation, credentials or backfill at install.
begin;
create table public.youtube_deletion_events (
  id uuid primary key default gen_random_uuid(),
  -- Minimal VOOM identity survives account deletion for pending delivery.
  -- Operator-approved retention is required; no Google identifiers/credentials.
  owner_user_id uuid not null,
  scope text not null check(scope in ('erase','retention')),
  requested_at timestamptz not null,
  cutoff_at timestamptz,
  journal_receipt text check(length(journal_receipt) between 1 and 128),
  recorded_at timestamptz,
  applied_at timestamptz,
  completion_receipt text check(length(completion_receipt) between 1 and 128),
  attempts integer not null default 0,
  retry_at timestamptz not null default now(),
  claim uuid,
  claimed_until timestamptz,
  failure_code text check(failure_code in ('destination_unavailable','capture_failed','erasure_failed')),
  failed_at timestamptz,
  alerted_at timestamptz,
  check((scope='retention')=(cutoff_at is not null)),
  check((journal_receipt is null)=(recorded_at is null))
);
create unique index youtube_retention_event on public.youtube_deletion_events(owner_user_id,cutoff_at) where scope='retention';
create unique index youtube_retention_pending on public.youtube_deletion_events(owner_user_id) where scope='retention' and applied_at is null;
create index youtube_deletion_delivery_due on public.youtube_deletion_events(retry_at) where completion_receipt is null or (failure_code is not null and alerted_at is null);
alter table public.youtube_deletion_events enable row level security;
revoke all on public.youtube_deletion_events from public,anon,authenticated,service_role;
grant select on public.youtube_deletion_events to service_role;
alter table public.youtube_privacy_controls add column deletion_event_id uuid references public.youtube_deletion_events(id);

-- Copy private implementation, then replace IN PLACE: preserve the public RPC's
-- OID so already prepared statements cannot retain a pre-gate function target.
do $$ begin
  execute replace(pg_get_functiondef('public.request_youtube_erasure(uuid,text)'::regprocedure),
    'CREATE OR REPLACE FUNCTION public.request_youtube_erasure(',
    'CREATE FUNCTION public.request_youtube_erasure_pre_delivery(');
end $$;
revoke all on function public.request_youtube_erasure_pre_delivery(uuid,text) from public,anon,authenticated,service_role;
create or replace function public.request_youtube_erasure(p_owner_user_id uuid,p_expected_epoch text default null)
returns boolean language plpgsql security definer set search_path='' as $$
declare control public.youtube_privacy_controls; event_id uuid;
begin
  insert into public.youtube_privacy_controls(owner_user_id) values(p_owner_user_id) on conflict do nothing;
  select * into control from public.youtube_privacy_controls where owner_user_id=p_owner_user_id for update;
  if p_expected_epoch is not null and not exists(select 1 from public.youtube_connections
    where owner_user_id=p_owner_user_id and id::text||':'||authorization_epoch::text=p_expected_epoch) then return false; end if;
  -- Retries, including a lost successful response, keep the original ID/deadline.
  if control.blocked and control.deletion_event_id is not null then return true; end if;
  if not public.request_youtube_erasure_pre_delivery(p_owner_user_id,p_expected_epoch) then return false; end if;
  insert into public.youtube_deletion_events(owner_user_id,scope,requested_at)
    select p_owner_user_id,'erase',requested_at from public.youtube_privacy_controls where owner_user_id=p_owner_user_id returning id into event_id;
  update public.youtube_privacy_controls set deletion_event_id=event_id where owner_user_id=p_owner_user_id;
  return true;
end $$;

do $$ begin
  execute replace(pg_get_functiondef('public.erase_youtube_data(uuid,boolean,text)'::regprocedure),
    'CREATE OR REPLACE FUNCTION public.erase_youtube_data(',
    'CREATE FUNCTION public.erase_youtube_data_pre_delivery(');
end $$;
revoke all on function public.erase_youtube_data_pre_delivery(uuid,boolean,text) from public,anon,authenticated,service_role;
create or replace function public.erase_youtube_data(p_owner_user_id uuid,p_revoke boolean default true,p_expected_epoch text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare event_id uuid; result jsonb;
begin
  -- Match 0065's draft -> control -> queue lock order.
  perform 1 from public.mara_drafts where owner_user_id=p_owner_user_id and kind in ('youtube_video','youtube_short') order by id for no key update;
  select deletion_event_id into event_id from public.youtube_privacy_controls where owner_user_id=p_owner_user_id and blocked for update;
  if event_id is null and not exists(select 1 from public.youtube_connections where owner_user_id=p_owner_user_id)
    and not exists(select 1 from public.youtube_publish_queue where owner_user_id=p_owner_user_id)
    and not exists(select 1 from public.youtube_performance_snapshots where owner_user_id=p_owner_user_id)
    and not exists(select 1 from public.youtube_oauth_states where owner_user_id=p_owner_user_id) then
    return jsonb_build_object('erased',true,'revocationPending',false);
  end if;
  if event_id is null or not exists(select 1 from public.youtube_deletion_events where id=event_id
    and owner_user_id=p_owner_user_id and scope='erase' and recorded_at is not null)
    then raise exception 'youtube_deletion_capture_required'; end if;
  if p_expected_epoch is not null and exists(select 1 from public.youtube_connections where owner_user_id=p_owner_user_id
    and id::text||':'||authorization_epoch::text<>p_expected_epoch) then raise exception 'youtube_grant_changed'; end if;
  if exists(select 1 from public.youtube_deletion_events where id=event_id and applied_at is not null) then
    return jsonb_build_object('erased',true,'revocationPending',exists(select 1 from public.youtube_revocation_tasks where owner_user_id=p_owner_user_id));
  end if;
  result:=public.erase_youtube_data_pre_delivery(p_owner_user_id,p_revoke,p_expected_epoch);
  update public.youtube_deletion_events set applied_at=coalesce(applied_at,clock_timestamp()) where id=event_id;
  return result;
end $$;

-- Stage maintenance work durably; do not erase through an unacknowledged intent.
create function public.prepare_youtube_deletion_events(p_limit integer default 25)
returns integer language plpgsql security definer set search_path='' as $$
declare owner_id uuid; total integer:=0; cutoff timestamptz:=now()-interval '28 days';
begin
  for owner_id in select c.owner_user_id from public.youtube_connections c
    where c.status<>'connected' or coalesce(c.authorization_checked_at,c.connected_at)<now()-interval '28 days'
      or exists(select 1 from public.youtube_privacy_controls p where p.owner_user_id=c.owner_user_id and p.blocked)
    order by c.owner_user_id limit greatest(1,least(p_limit,100)) loop
    perform public.request_youtube_erasure(owner_id); total:=total+1;
  end loop;
  for owner_id in select distinct s.owner_user_id from (
    select owner_user_id from public.youtube_performance_snapshots where collected_at<cutoff
    union select owner_user_id from public.youtube_publish_queue where (youtube_video_id is not null or upload_session_url is not null)
      and coalesce(last_provider_check_at,last_attempt_at,created_at)<cutoff
  ) s order by s.owner_user_id limit greatest(1,least(p_limit,100)) loop
    insert into public.youtube_deletion_events(owner_user_id,scope,requested_at,cutoff_at) values(owner_id,'retention',clock_timestamp(),cutoff)
      on conflict do nothing;
    total:=total+1;
  end loop;
  return total;
end $$;

-- Existing routine/cadence; applied retention is scoped to the ACKNOWLEDGED cutoff.
create or replace function public.prune_youtube_api_data(p_limit integer default 25)
returns integer language plpgsql security definer set search_path='' as $$
declare event public.youtube_deletion_events; job record; total integer:=0;
begin
  -- Credential expiry is a security obligation, not contingent on a journal outage.
  update public.youtube_revocation_tasks set encrypted_token=null,iv=null,auth_tag=null,expired=true,claim=null,claimed_until=null where expires_at<=now() and not expired;
  delete from public.youtube_oauth_states where expires_at<now();
  for event in select * from public.youtube_deletion_events where recorded_at is not null and applied_at is null
    -- Same owner ordering as preparation avoids inverted multi-owner control locks.
    order by owner_user_id,requested_at,id limit greatest(1,least(p_limit,100)) loop
    begin
    perform 1 from public.mara_drafts where owner_user_id=event.owner_user_id and kind in ('youtube_video','youtube_short') order by id for no key update;
    insert into public.youtube_privacy_controls(owner_user_id) values(event.owner_user_id) on conflict do nothing;
    perform 1 from public.youtube_privacy_controls where owner_user_id=event.owner_user_id for update;
    if exists(select 1 from public.youtube_deletion_events where id=event.id and applied_at is not null) then continue; end if;
    if event.scope='erase' then
      -- Only the still-current request may act after a later authorization.
      if exists(select 1 from public.youtube_privacy_controls where owner_user_id=event.owner_user_id
        and blocked and deletion_event_id=event.id) then
        perform public.erase_youtube_data(event.owner_user_id,true); total:=total+1;
      end if;
    else
      for job in select q.id,q.draft_id from public.youtube_publish_queue q where q.owner_user_id=event.owner_user_id
        and (q.youtube_video_id is not null or q.upload_session_url is not null)
        and coalesce(q.last_provider_check_at,q.last_attempt_at,q.created_at)<event.cutoff_at order by q.id loop
        perform 1 from public.mara_drafts where id=job.draft_id for no key update;
        insert into public.youtube_privacy_controls(owner_user_id) values(event.owner_user_id) on conflict do nothing;
        update public.youtube_privacy_controls set erasing=true where owner_user_id=event.owner_user_id;
        insert into public.youtube_erased_publications values(event.owner_user_id,job.draft_id) on conflict do nothing;
        delete from public.youtube_performance_snapshots where owner_user_id=event.owner_user_id and publish_queue_id=job.id;
        delete from public.youtube_publish_queue where id=job.id and owner_user_id=event.owner_user_id;
        update public.mara_drafts set provider_ref=null,status='draft' where id=job.draft_id and owner_user_id=event.owner_user_id;
        update public.youtube_privacy_controls set erasing=false where owner_user_id=event.owner_user_id;
      end loop;
      delete from public.youtube_performance_snapshots where owner_user_id=event.owner_user_id and collected_at<event.cutoff_at;
      update public.youtube_deletion_events set applied_at=coalesce(applied_at,clock_timestamp()) where id=event.id;
    end if;
    exception when others then
      -- Roll back this owner's purge; retain the original intent and retry later.
      update public.youtube_deletion_events set failure_code='erasure_failed',failed_at=coalesce(failed_at,clock_timestamp()),
        alerted_at=case when failure_code='erasure_failed' then alerted_at else null end,retry_at=now() where id=event.id;
    end;
  end loop;
  return total;
end $$;

create function public.flag_youtube_deletion_failure(p_owner uuid)
returns void language sql security definer set search_path='' as $$
  update public.youtube_deletion_events set failure_code='erasure_failed',failed_at=coalesce(failed_at,clock_timestamp()),
    alerted_at=case when failure_code='erasure_failed' then alerted_at else null end,retry_at=now()
    where id=(select deletion_event_id from public.youtube_privacy_controls where owner_user_id=p_owner and blocked)
      and owner_user_id=p_owner and applied_at is null
$$;

create function public.claim_youtube_deletion_events(p_limit integer default 5,p_owner uuid default null)
returns setof public.youtube_deletion_events language plpgsql security definer set search_path='' as $$
begin
  return query with due as(select id from public.youtube_deletion_events
    where (completion_receipt is null or (failure_code is not null and alerted_at is null))
      and retry_at<=now() and (claimed_until is null or claimed_until<now()) and (p_owner is null or owner_user_id=p_owner)
    order by requested_at,id for update skip locked limit greatest(1,least(p_limit,25)))
    update public.youtube_deletion_events e set claim=gen_random_uuid(),claimed_until=now()+interval '2 minutes',attempts=attempts+1
      from due where e.id=due.id returning e.*;
end $$;
create function public.finish_youtube_deletion_event(p_id uuid,p_owner uuid,p_claim uuid,p_receipt text default null,p_alerted boolean default false,p_failure text default null,p_completion text default null)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  update public.youtube_deletion_events set journal_receipt=coalesce(journal_receipt,p_receipt),
    completion_receipt=coalesce(completion_receipt,p_completion),
    recorded_at=case when p_receipt is not null then coalesce(recorded_at,clock_timestamp()) else recorded_at end,
    failure_code=coalesce(p_failure,failure_code),failed_at=case when p_failure is not null then coalesce(failed_at,clock_timestamp()) else failed_at end,
    alerted_at=case when p_alerted then coalesce(alerted_at,clock_timestamp()) when p_failure is distinct from failure_code and p_failure is not null then null else alerted_at end,
    retry_at=case when p_failure is null and (failure_code is null or p_alerted or alerted_at is not null) then now()
      else now()+make_interval(secs=>least(3600,30*power(2,least(attempts,6)))::integer) end,claim=null,claimed_until=null
    where id=p_id and owner_user_id=p_owner and claim=p_claim and claimed_until>now()
      and (p_receipt is null or journal_receipt is null or journal_receipt=p_receipt)
      and (p_completion is null or (applied_at is not null and journal_receipt is not null and (completion_receipt is null or completion_receipt=p_completion)));
  return found;
end $$;

revoke all on function public.request_youtube_erasure(uuid,text),public.erase_youtube_data(uuid,boolean,text),
  public.prepare_youtube_deletion_events(integer),public.claim_youtube_deletion_events(integer,uuid),
  public.flag_youtube_deletion_failure(uuid),
  public.finish_youtube_deletion_event(uuid,uuid,uuid,text,boolean,text,text) from public,anon,authenticated;
grant execute on function public.request_youtube_erasure(uuid,text),public.erase_youtube_data(uuid,boolean,text),
  public.prepare_youtube_deletion_events(integer),public.claim_youtube_deletion_events(integer,uuid),
  public.flag_youtube_deletion_failure(uuid),
  public.finish_youtube_deletion_event(uuid,uuid,uuid,text,boolean,text,text) to service_role;
notify pgrst,'reload schema';
commit;
