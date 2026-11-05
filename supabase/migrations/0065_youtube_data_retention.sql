-- YouTube-only erasure. No data is deleted and no cron/provider is invoked by installation.
-- Deploy application after this migration. Existing worker schedules are reused.
begin;

create table public.youtube_privacy_controls (
  owner_user_id uuid primary key references auth.users(id) on delete cascade,
  erased_at timestamptz,
  requested_at timestamptz,
  completed_at timestamptz,
  blocked boolean not null default false,
  erasing boolean not null default false
);
-- Only Voom action identity, NEVER a Google video/channel id, URL or metadata.
create table public.youtube_erased_publications (
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  draft_id uuid not null,
  primary key(owner_user_id,draft_id),
  foreign key(draft_id,owner_user_id) references public.mara_drafts(id,owner_user_id) on delete cascade
);
create table public.youtube_revocation_tasks (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references auth.users(id) on delete set null,
  encrypted_token text,
  iv text,
  auth_tag text,
  -- One-day operational margin before the policy's seven-day maximum.
  expires_at timestamptz not null default clock_timestamp()+interval '6 days',
  next_attempt_at timestamptz not null default now(),
  claim uuid,
  claimed_until timestamptz,
  attempts integer not null default 0,
  -- No provider errors/bodies or credentials in operational diagnostics.
  expired boolean not null default false,
  check ((encrypted_token is null) = (iv is null)),
  check ((encrypted_token is null) = (auth_tag is null))
);
create unique index youtube_revocation_owner_pending on public.youtube_revocation_tasks(owner_user_id) where owner_user_id is not null;
create index youtube_revocation_due on public.youtube_revocation_tasks(next_attempt_at) where not expired;
alter table public.youtube_connections add column authorization_checked_at timestamptz;
alter table public.youtube_connections add column authorization_epoch uuid not null default gen_random_uuid();
create index youtube_authorization_check_due on public.youtube_connections(authorization_checked_at) where status='connected';
alter table public.youtube_privacy_controls enable row level security;
alter table public.youtube_erased_publications enable row level security;
alter table public.youtube_revocation_tasks enable row level security;
revoke all on public.youtube_privacy_controls,public.youtube_erased_publications,public.youtube_revocation_tasks from public,anon,authenticated;
revoke all on public.youtube_privacy_controls,public.youtube_erased_publications from service_role;
grant select on public.youtube_privacy_controls,public.youtube_erased_publications to service_role;
-- Revocation ciphertext is accessible ONLY through leased server RPCs.
revoke all on public.youtube_revocation_tasks from service_role;

-- Commit this small barrier first in server code. A later purge failure remains
-- blocked and is picked up by maintenance instead of losing a deletion request.
create function public.request_youtube_erasure(p_owner_user_id uuid,p_expected_epoch text default null)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  insert into public.youtube_privacy_controls(owner_user_id) values(p_owner_user_id) on conflict do nothing;
  perform 1 from public.youtube_privacy_controls where owner_user_id=p_owner_user_id for update;
  if p_expected_epoch is not null and not exists(select 1 from public.youtube_connections
    where owner_user_id=p_owner_user_id and id::text||':'||authorization_epoch::text=p_expected_epoch) then return false; end if;
  update public.youtube_privacy_controls set blocked=true,
    requested_at=case when blocked and completed_at is null then coalesce(requested_at,clock_timestamp()) else clock_timestamp() end,
    completed_at=null where owner_user_id=p_owner_user_id;
  return true;
end $$;

create function public.erase_youtube_data(p_owner_user_id uuid,p_revoke boolean default true,p_expected_epoch text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare task_id uuid;
begin
  -- Always lock drafts before queues, matching approval/media attachment.
  perform 1 from public.mara_drafts where owner_user_id=p_owner_user_id
    and kind in ('youtube_video','youtube_short') order by id for no key update;
  insert into public.youtube_privacy_controls(owner_user_id) values(p_owner_user_id)
    on conflict(owner_user_id) do nothing;
  perform 1 from public.youtube_privacy_controls where owner_user_id=p_owner_user_id for update;
  if p_expected_epoch is not null and exists(select 1 from public.youtube_connections where owner_user_id=p_owner_user_id
    and id::text||':'||authorization_epoch::text<>p_expected_epoch) then raise exception 'youtube_grant_changed'; end if;
  if p_revoke then
    insert into public.youtube_revocation_tasks(owner_user_id,encrypted_token,iv,auth_tag)
      select owner_user_id,encrypted_refresh_token,refresh_iv,refresh_auth_tag
      from public.youtube_connection_secrets where owner_user_id=p_owner_user_id
      on conflict(owner_user_id) where owner_user_id is not null do nothing;
  end if;
  select id into task_id from public.youtube_revocation_tasks where owner_user_id=p_owner_user_id;
  update public.youtube_privacy_controls set blocked=true,erasing=true,erased_at=clock_timestamp(),
    requested_at=case when blocked and completed_at is null then coalesce(requested_at,clock_timestamp()) else clock_timestamp() end
    where owner_user_id=p_owner_user_id;
  -- A provider-owned/uncertain action must never silently become a fresh upload.
  insert into public.youtube_erased_publications(owner_user_id,draft_id)
    select owner_user_id,draft_id from public.youtube_publish_queue where owner_user_id=p_owner_user_id
      and (attempts>0 or upload_session_url is not null or youtube_video_id is not null)
    on conflict do nothing;
  delete from public.youtube_performance_snapshots where owner_user_id=p_owner_user_id;
  delete from public.youtube_publish_queue where owner_user_id=p_owner_user_id;
  update public.mara_drafts set provider_ref=null,status='draft' where owner_user_id=p_owner_user_id
    and kind in ('youtube_video','youtube_short') and (provider_ref is not null or status='approved');
  delete from public.youtube_oauth_states where owner_user_id=p_owner_user_id;
  delete from public.youtube_connections where owner_user_id=p_owner_user_id;
  update public.youtube_privacy_controls set erasing=false,completed_at=clock_timestamp() where owner_user_id=p_owner_user_id;
  return jsonb_build_object('erased',true,'revocationId',task_id,'revocationPending',task_id is not null);
end $$;

-- Preserve the normal immutable-publication guard. Its sole erasure exception
-- is private, transaction-scoped state written by erase_youtube_data, not a GUC.
create or replace function public.youtube_publish_queue_guard()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='DELETE' then
    if old.status='published' and not exists(select 1 from public.youtube_privacy_controls
      where owner_user_id=old.owner_user_id and erasing) then raise exception 'youtube_publish_already_published'; end if;
    return old;
  end if;
  if old.status='published' and (new.status<>'published' or new.youtube_video_id is distinct from old.youtube_video_id
    or new.published_at is distinct from old.published_at) then raise exception 'youtube_publish_already_published'; end if;
  return new;
end $$;

create function public.youtube_erasure_write_guard()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  -- Lock the owner barrier: an in-flight result cannot resurrect erased data.
  if tg_op='INSERT' then
    insert into public.youtube_privacy_controls(owner_user_id) values(new.owner_user_id) on conflict do nothing;
    perform 1 from public.youtube_privacy_controls where owner_user_id=new.owner_user_id for share;
  end if;
  if exists(select 1 from public.youtube_privacy_controls where owner_user_id=new.owner_user_id and blocked)
    then raise exception 'youtube_data_erased_reconnect_required'; end if;
  if tg_table_name='youtube_publish_queue' and tg_op='INSERT' then
    if exists(select 1 from public.youtube_erased_publications where owner_user_id=new.owner_user_id and draft_id=new.draft_id)
      then raise exception 'youtube_previous_submission_erased_do_not_retry'; end if;
  end if;
  if tg_table_name='youtube_performance_snapshots' then
    if exists(select 1 from public.youtube_privacy_controls where owner_user_id=new.owner_user_id and erased_at is not null)
      and not exists(select 1 from public.youtube_publish_queue where id=new.publish_queue_id and owner_user_id=new.owner_user_id)
      then raise exception 'youtube_erased_publication'; end if;
  end if;
  return new;
end $$;
create trigger youtube_queue_erasure_guard before insert or update on public.youtube_publish_queue for each row execute function public.youtube_erasure_write_guard();
create trigger youtube_snapshot_erasure_guard before insert or update on public.youtube_performance_snapshots for each row execute function public.youtube_erasure_write_guard();
create trigger youtube_connection_erasure_guard before insert or update on public.youtube_connections for each row execute function public.youtube_erasure_write_guard();
create trigger youtube_secret_erasure_guard before insert or update on public.youtube_connection_secrets for each row execute function public.youtube_erasure_write_guard();

-- Keep the existing save implementation private. The wrapper requires a fresh,
-- consumed owner-bound OAuth state after an erasure, inside the same barrier.
alter function public.save_youtube_connection(uuid,text,text,text,text,text[],text,text,text,smallint,text,text,text,smallint,timestamptz) rename to save_youtube_connection_internal;
revoke all on function public.save_youtube_connection_internal(uuid,text,text,text,text,text[],text,text,text,smallint,text,text,text,smallint,timestamptz) from public,anon,authenticated,service_role;
create function public.save_youtube_connection(
  p_owner_user_id uuid,p_channel_id text,p_channel_title text,p_channel_handle text,p_thumbnail_url text,p_scopes text[],
  p_encrypted_refresh_token text,p_refresh_iv text,p_refresh_auth_tag text,p_refresh_key_version smallint,
  p_encrypted_access_token text,p_access_iv text,p_access_auth_tag text,p_access_key_version smallint,
  p_access_token_expires_at timestamptz,p_state_hash text default null
) returns uuid language plpgsql security definer set search_path='' as $$
declare result uuid; cutoff timestamptz;
begin
  insert into public.youtube_privacy_controls(owner_user_id) values(p_owner_user_id) on conflict do nothing;
  perform 1 from public.youtube_privacy_controls where owner_user_id=p_owner_user_id for update;
  select erased_at into cutoff from public.youtube_privacy_controls where owner_user_id=p_owner_user_id;
  if exists(select 1 from public.youtube_privacy_controls where owner_user_id=p_owner_user_id and blocked and requested_at is not null and completed_at is null)
    then raise exception 'youtube_erasure_pending'; end if;
  if exists(select 1 from public.youtube_revocation_tasks where owner_user_id=p_owner_user_id)
    then raise exception 'youtube_revocation_pending'; end if;
  if cutoff is not null and not exists(select 1 from public.youtube_oauth_states
    where owner_user_id=p_owner_user_id and state_hash=p_state_hash and consumed_at is not null
      and created_at>cutoff and expires_at>now()) then raise exception 'youtube_fresh_consent_required'; end if;
  update public.youtube_privacy_controls set blocked=false where owner_user_id=p_owner_user_id;
  result:=public.save_youtube_connection_internal(p_owner_user_id,p_channel_id,p_channel_title,p_channel_handle,p_thumbnail_url,p_scopes,
    p_encrypted_refresh_token,p_refresh_iv,p_refresh_auth_tag,p_refresh_key_version,p_encrypted_access_token,p_access_iv,p_access_auth_tag,p_access_key_version,p_access_token_expires_at);
  update public.youtube_connections set authorization_checked_at=now(),authorization_epoch=gen_random_uuid() where owner_user_id=p_owner_user_id;
  return result;
end $$;

-- Old callers still receive true. New callers use erase_youtube_data's receipt.
create or replace function public.disconnect_youtube_connection(p_owner_user_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin perform public.erase_youtube_data(p_owner_user_id,true); return true; end $$;

-- Any confirmed invalid/revoked authorization erases immediately, not merely
-- a UI status flip. Transient network/5xx failures must NOT call this path.
create or replace function public.set_youtube_connection_status(p_owner_user_id uuid,p_status text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if p_status not in ('connected','expired','revoked','error','disconnected') then raise exception 'youtube_connection_status_invalid'; end if;
  if p_status in ('expired','revoked','disconnected') then
    perform public.erase_youtube_data(p_owner_user_id,p_status='disconnected'); return true;
  end if;
  update public.youtube_connections set status=p_status where owner_user_id=p_owner_user_id;
  return found;
end $$;

create function public.youtube_before_account_delete() returns trigger
language plpgsql security definer set search_path='' as $$
begin perform public.erase_youtube_data(old.id,true); return old; end $$;
create trigger youtube_account_delete before delete on auth.users for each row execute function public.youtube_before_account_delete();

-- Erasure and completion must both take draft -> queue locks, never the reverse.
create or replace function public.complete_youtube_publish_job(p_id uuid,p_owner_user_id uuid,
  p_provider_upload_status text,p_provider_privacy_status text,p_provider_note text)
returns public.youtube_publish_queue language plpgsql security definer set search_path='' as $$
declare v_row public.youtube_publish_queue;
begin
  if p_provider_upload_status is distinct from 'processed' then raise exception 'youtube_publish_not_processed'; end if;
  perform 1 from public.mara_drafts d where d.owner_user_id=p_owner_user_id
    and d.id=(select q.draft_id from public.youtube_publish_queue q where q.id=p_id and q.owner_user_id=p_owner_user_id) for no key update;
  select * into v_row from public.youtube_publish_queue where id=p_id and owner_user_id=p_owner_user_id for update;
  if not found then raise exception 'youtube_publish_job_not_found'; end if;
  if v_row.youtube_video_id is null then raise exception 'youtube_video_id_required'; end if;
  if v_row.status='published' then return v_row; end if;
  update public.youtube_publish_queue set status='published',provider_upload_status='processed',
    provider_privacy_status=coalesce(p_provider_privacy_status,provider_privacy_status),provider_note=left(coalesce(p_provider_note,provider_note),300),
    published_at=now(),claimed_at=null,failure_code=null,failure_message=null,last_provider_check_at=now()
    where id=v_row.id returning * into v_row;
  update public.mara_drafts set provider_ref=v_row.youtube_video_id where id=v_row.draft_id and owner_user_id=p_owner_user_id
    and (provider_ref is null or provider_ref=v_row.youtube_video_id);
  return v_row;
end $$;

alter function public.update_youtube_access_token(uuid,text,text,text,smallint,timestamptz) rename to update_youtube_access_token_internal;
revoke all on function public.update_youtube_access_token_internal(uuid,text,text,text,smallint,timestamptz) from public,anon,authenticated,service_role;
create function public.update_youtube_access_token(p_owner_user_id uuid,p_encrypted_access_token text,p_access_iv text,p_access_auth_tag text,
  p_access_key_version smallint,p_access_token_expires_at timestamptz,p_expected_epoch text default null)
returns boolean language plpgsql security definer set search_path='' as $$
declare c public.youtube_connections;
begin
  select * into c from public.youtube_connections where owner_user_id=p_owner_user_id for update;
  if c.id is null or c.status<>'connected' then return false; end if;
  if p_expected_epoch is not null and (c.id::text<>split_part(p_expected_epoch,':',1)
    or c.authorization_epoch::text<>split_part(p_expected_epoch,':',2)) then return false; end if;
  return public.update_youtube_access_token_internal(p_owner_user_id,p_encrypted_access_token,p_access_iv,p_access_auth_tag,p_access_key_version,p_access_token_expires_at);
end $$;

create function public.claim_youtube_revocation_tasks(p_limit integer default 10,p_owner uuid default null)
returns setof public.youtube_revocation_tasks language plpgsql security definer set search_path='' as $$
begin
  -- Never retain revocation ciphertext beyond seven days, even on failure.
  update public.youtube_revocation_tasks set encrypted_token=null,iv=null,auth_tag=null,expired=true,claim=null,claimed_until=null
    where expires_at<=now() and not expired;
  return query with due as (select id from public.youtube_revocation_tasks where not expired and next_attempt_at<=now()
    and (claimed_until is null or claimed_until<now()) and (p_owner is null or owner_user_id=p_owner)
    order by next_attempt_at for update skip locked limit greatest(1,least(p_limit,50)))
    update public.youtube_revocation_tasks t set claim=gen_random_uuid(),claimed_until=now()+interval '2 minutes',attempts=attempts+1
    from due where t.id=due.id returning t.*;
end $$;
create function public.finish_youtube_revocation(p_id uuid,p_claim uuid,p_success boolean)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if p_success then delete from public.youtube_revocation_tasks where id=p_id and claim=p_claim;
  else update public.youtube_revocation_tasks set claim=null,claimed_until=null,next_attempt_at=now()+interval '5 minutes'
    where id=p_id and claim=p_claim; end if;
  return found;
end $$;

-- Bounded maintenance, reused by the existing authenticated reconcile cron.
-- 28-day TTL is conservative; historical metrics are not retained indefinitely.
create function public.prune_youtube_api_data(p_limit integer default 25)
returns integer language plpgsql security definer set search_path='' as $$
declare owner_id uuid; total integer:=0; job record;
begin
  update public.youtube_revocation_tasks set encrypted_token=null,iv=null,auth_tag=null,expired=true,claim=null,claimed_until=null
    where expires_at<=now() and not expired;
  for owner_id in select owner_user_id from public.youtube_connections
    where status<>'connected' or coalesce(authorization_checked_at,connected_at)<now()-interval '28 days'
      or exists(select 1 from public.youtube_privacy_controls p where p.owner_user_id=youtube_connections.owner_user_id and p.blocked)
    order by coalesce(authorization_checked_at,connected_at) limit greatest(1,least(p_limit,100)) loop
    perform public.erase_youtube_data(owner_id,true); total:=total+1;
  end loop;
  delete from public.youtube_oauth_states where expires_at<now();
  delete from public.youtube_performance_snapshots where collected_at<now()-interval '28 days';
  -- Stale provider evidence must be removed even when the channel remains valid.
  for job in select q.owner_user_id,q.draft_id,q.id from public.youtube_publish_queue q
    where (q.youtube_video_id is not null or q.upload_session_url is not null)
      and coalesce(q.last_provider_check_at,q.last_attempt_at,q.created_at)<now()-interval '28 days'
    order by coalesce(q.last_provider_check_at,q.last_attempt_at,q.created_at) limit greatest(1,least(p_limit,100)) loop
    perform 1 from public.mara_drafts where id=job.draft_id for no key update;
    insert into public.youtube_privacy_controls(owner_user_id) values(job.owner_user_id) on conflict do nothing;
    update public.youtube_privacy_controls set erasing=true where owner_user_id=job.owner_user_id;
    insert into public.youtube_erased_publications values(job.owner_user_id,job.draft_id) on conflict do nothing;
    delete from public.youtube_performance_snapshots where owner_user_id=job.owner_user_id and publish_queue_id=job.id;
    delete from public.youtube_publish_queue where id=job.id and owner_user_id=job.owner_user_id;
    update public.mara_drafts set provider_ref=null,status='draft' where id=job.draft_id and owner_user_id=job.owner_user_id;
    update public.youtube_privacy_controls set erasing=false where owner_user_id=job.owner_user_id;
  end loop;
  return total;
end $$;

create function public.youtube_privacy_backlog()
returns jsonb language sql security definer set search_path='' as $$
  select jsonb_build_object('expiredRevocations',(select count(*) from public.youtube_revocation_tasks where expired),
    'lateErasures',(select count(*) from public.youtube_privacy_controls where completed_at>requested_at+interval '7 days'),
    'overdueErasures',(select count(*) from public.youtube_privacy_controls p where p.blocked
      and p.requested_at<now()-interval '7 days' and (exists(select 1 from public.youtube_connections c where c.owner_user_id=p.owner_user_id)
        or exists(select 1 from public.youtube_publish_queue q where q.owner_user_id=p.owner_user_id)
        or exists(select 1 from public.youtube_performance_snapshots s where s.owner_user_id=p.owner_user_id))))
$$;

revoke all on function public.request_youtube_erasure(uuid,text),public.erase_youtube_data(uuid,boolean,text),public.claim_youtube_revocation_tasks(integer,uuid),public.finish_youtube_revocation(uuid,uuid,boolean),public.prune_youtube_api_data(integer),public.save_youtube_connection(uuid,text,text,text,text,text[],text,text,text,smallint,text,text,text,smallint,timestamptz,text) from public,anon,authenticated;
grant execute on function public.request_youtube_erasure(uuid,text),public.erase_youtube_data(uuid,boolean,text),public.claim_youtube_revocation_tasks(integer,uuid),public.finish_youtube_revocation(uuid,uuid,boolean),public.prune_youtube_api_data(integer),public.save_youtube_connection(uuid,text,text,text,text,text[],text,text,text,smallint,text,text,text,smallint,timestamptz,text) to service_role;
revoke all on function public.youtube_erasure_write_guard(),public.youtube_before_account_delete(),public.youtube_publish_queue_guard() from public,anon,authenticated;
revoke all on function public.update_youtube_access_token(uuid,text,text,text,smallint,timestamptz,text),public.youtube_privacy_backlog() from public,anon,authenticated;
grant execute on function public.update_youtube_access_token(uuid,text,text,text,smallint,timestamptz,text),public.youtube_privacy_backlog() to service_role;
notify pgrst,'reload schema';
commit;
