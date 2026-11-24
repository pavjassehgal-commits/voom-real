-- Local approval-safety proposal. NOT applied to any hosted database.
-- 0079 is reserved by the separate memory candidate; preserve production 0078.
begin;

-- One minute of scheduling lead, twenty minutes of automatic-publish grace.
-- The grace is measured from mara_drafts.proposed_publish_at (the approved
-- schedule), NEVER the queue's mutable scheduled_at retry clock.
create or replace function public.content_schedule_lead() returns interval language sql immutable set search_path='' as $$ select interval '1 minute' $$;
create or replace function public.instagram_publish_grace() returns interval language sql immutable set search_path='' as $$ select interval '20 minutes' $$;
revoke all on function public.content_schedule_lead() from public,anon,authenticated;
revoke all on function public.instagram_publish_grace() from public,anon,authenticated;
grant execute on function public.content_schedule_lead() to service_role;
grant execute on function public.instagram_publish_grace() to service_role;

create or replace function public.approve_reviewed_post(
  p_owner_user_id uuid, p_draft_id uuid, p_content_version bigint,
  p_origin text default 'user', p_action_id uuid default null, p_campaign_action_id uuid default null
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  d public.mara_drafts%rowtype;
  a public.mara_pending_actions%rowtype;
  v_timezone text;
begin
  if p_content_version is null or p_content_version < 1 then raise exception 'approval_content_changed'; end if;
  if p_origin not in ('user', 'autopilot') then raise exception 'approval_invalid_state'; end if;
  -- Lock sibling decisions in a stable order before the draft. Two cards for
  -- one draft cannot each hold a different action while waiting for the other.
  perform 1 from public.mara_pending_actions
    where owner_user_id=p_owner_user_id and tool_name in ('propose_calendar_item','approve_draft')
      and coalesce(sanitized_arguments->>'sourceDraftId',sanitized_arguments->>'draftId')=p_draft_id::text
    order by id for update;
  if p_action_id is not null then
    select * into a from public.mara_pending_actions where id=p_action_id and owner_user_id=p_owner_user_id for update;
    if not found or a.status <> 'executing' or a.tool_name not in ('propose_calendar_item','approve_draft')
      or coalesce(a.sanitized_arguments->>'sourceDraftId',a.sanitized_arguments->>'draftId') is distinct from p_draft_id::text
      or a.sanitized_arguments->>'contentVersion' is distinct from p_content_version::text then
      raise exception 'approval_content_changed';
    end if;
  end if;
  if p_campaign_action_id is not null then
    perform 1 from public.voom_campaign_actions where id=p_campaign_action_id and owner_user_id=p_owner_user_id
      and draft_id=p_draft_id and status in ('proposed','needs_approval','approved','scheduled','failed') for update;
    if not found then raise exception 'approval_invalid_state'; end if;
  end if;
  select * into d from public.mara_drafts where id=p_draft_id and owner_user_id=p_owner_user_id for update;
  if not found or d.content_version <> p_content_version then raise exception 'approval_content_changed'; end if;
  -- Never bypass native platform-specific consent via this Instagram boundary.
  if d.kind not in ('instagram_post','reel','story') or d.status not in ('draft','approved') then
    raise exception 'approval_invalid_state';
  end if;
  perform 1 from public.instagram_publish_queue where draft_id=d.id and owner_user_id=p_owner_user_id for update;
  if exists(select 1 from public.instagram_publish_queue where draft_id=d.id and owner_user_id=p_owner_user_id
    and (status in ('publishing','published') or container_id is not null or instagram_media_id is not null)) then
    raise exception 'approval_invalid_state';
  end if;
  select coalesce(nullif(timezone,''),'Asia/Dubai') into v_timezone from public.businesses where owner_user_id=p_owner_user_id;
  if v_timezone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=v_timezone) then
    raise exception 'approval_timezone_unavailable';
  end if;
  -- Stored timestamptz is authoritative. Comparing instants is independent of
  -- the viewer's timezone; the server UI interprets new choices in this zone.
  if (p_action_id is not null and a.tool_name='propose_calendar_item' and d.proposed_publish_at is null)
    or (d.proposed_publish_at is not null and d.proposed_publish_at < clock_timestamp() + public.content_schedule_lead()) then
    raise exception 'approval_schedule_expired';
  end if;
  if d.kind <> 'story' and btrim(d.content)='' then raise exception 'approval_incomplete'; end if;
  if d.kind in ('instagram_post','reel','story') and not exists(select 1 from public.post_draft_assets
    where draft_id=d.id and owner_user_id=p_owner_user_id and status='uploaded') then raise exception 'approval_incomplete'; end if;
  if d.status='approved' and d.approved_content_version is distinct from d.content_version then raise exception 'approval_content_changed'; end if;
  if d.status <> 'approved' then
    update public.mara_drafts set status='approved', approval_origin=p_origin where id=d.id and owner_user_id=p_owner_user_id;
  end if;
  if p_action_id is not null then
    update public.mara_pending_actions set status='confirmed',result_summary='Approved the reviewed version.',error_summary=null,executed_at=clock_timestamp()
      where id=p_action_id and owner_user_id=p_owner_user_id;
  end if;
  -- Only this explicit reviewed approval may reopen a terminal queue row.
  -- Keep it unclaimable until the normal sync has refreshed all queue fields.
  update public.instagram_publish_queue set status='failed',failure_code='owner_approved_sync_required',
    failure_message='Owner approved the current version; synchronize this item to finish scheduling.'
    where owner_user_id=p_owner_user_id and draft_id=p_draft_id and container_id is null and instagram_media_id is null
      and (status='cancelled' or failure_code='instagram_schedule_expired');
  -- Close only snapshots covering this version; obsolete cards cannot later run.
  update public.mara_pending_actions set
    status=case when sanitized_arguments->>'contentVersion'=p_content_version::text then 'confirmed' else 'cancelled' end,
    result_summary='Resolved by the reviewed draft decision.',executed_at=clock_timestamp()
    where owner_user_id=p_owner_user_id and status in ('pending','failed')
      and tool_name in ('propose_calendar_item','approve_draft')
      and coalesce(sanitized_arguments->>'sourceDraftId',sanitized_arguments->>'draftId')=d.id::text;
  if p_campaign_action_id is not null then
    update public.voom_campaign_actions set status='approved' where id=p_campaign_action_id and owner_user_id=p_owner_user_id;
  end if;
  update public.mara_tool_runs r set
    status=case when pa.status='confirmed' then 'succeeded' else 'rejected' end,
    result_summary=pa.result_summary, completed_at=clock_timestamp()
    from public.mara_pending_actions pa where r.pending_action_id=pa.id and r.owner_user_id=p_owner_user_id
      and pa.owner_user_id=p_owner_user_id and pa.status in ('confirmed','cancelled')
      and coalesce(pa.sanitized_arguments->>'sourceDraftId',pa.sanitized_arguments->>'draftId')=d.id::text
      and r.status in ('pending_confirmation','running');
  return d.status <> 'approved';
end $$;
revoke all on function public.approve_reviewed_post(uuid,uuid,bigint,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.approve_reviewed_post(uuid,uuid,bigint,text,uuid,uuid) to service_role;

-- Standalone calendar proposals have no content draft. Claim + insert + final
-- action status are one transaction, so retries cannot create duplicate rows.
create or replace function public.confirm_calendar_proposal(p_owner_user_id uuid,p_action_id uuid)
returns public.content_calendar_items language plpgsql security definer set search_path = '' as $$
declare a public.mara_pending_actions%rowtype; item public.content_calendar_items%rowtype; at timestamptz; tz text;
begin
  select * into a from public.mara_pending_actions where id=p_action_id and owner_user_id=p_owner_user_id for update;
  if not found or a.status <> 'executing' or a.tool_name <> 'propose_calendar_item'
    or nullif(a.sanitized_arguments->>'sourceDraftId','') is not null then raise exception 'approval_invalid_state'; end if;
  select timezone into tz from public.businesses where owner_user_id=p_owner_user_id;
  if tz is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=tz) then raise exception 'approval_timezone_unavailable'; end if;
  at := (a.sanitized_arguments->>'publishAt')::timestamptz;
  if at is null or at < clock_timestamp()+public.content_schedule_lead() then raise exception 'approval_schedule_expired'; end if;
  insert into public.content_calendar_items(owner_user_id,title,channel,content,topic,publish_at,status)
    values(p_owner_user_id,a.sanitized_arguments->>'title',a.sanitized_arguments->>'channel',
      coalesce(a.sanitized_arguments->>'content',''),coalesce(a.sanitized_arguments->>'topic',''),at,'approved') returning * into item;
  update public.mara_pending_actions set status='confirmed',error_summary=null,executed_at=clock_timestamp(),result_summary='Added the reviewed proposal to the calendar.' where id=a.id;
  return item;
end $$;
revoke all on function public.confirm_calendar_proposal(uuid,uuid) from public,anon,authenticated;
grant execute on function public.confirm_calendar_proposal(uuid,uuid) to service_role;

create or replace function public.reject_reviewed_post(p_owner_user_id uuid,p_draft_id uuid,p_action_id uuid default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare d public.mara_drafts%rowtype; a public.mara_pending_actions%rowtype;
begin
  -- Lock sibling decisions in a stable order before the draft. Two cards for
  -- one draft cannot each hold a different action while waiting for the other.
  perform 1 from public.mara_pending_actions
    where owner_user_id=p_owner_user_id and tool_name in ('propose_calendar_item','approve_draft')
      and coalesce(sanitized_arguments->>'sourceDraftId',sanitized_arguments->>'draftId')=p_draft_id::text
    order by id for update;
  if p_action_id is not null then
    select * into a from public.mara_pending_actions where id=p_action_id and owner_user_id=p_owner_user_id for update;
    if not found or a.status not in ('pending','failed') or a.sanitized_arguments->>'sourceDraftId' is distinct from p_draft_id::text then
      raise exception 'approval_invalid_state'; end if;
  end if;
  select * into d from public.mara_drafts where id=p_draft_id and owner_user_id=p_owner_user_id for update;
  if not found then return false; end if;
  perform 1 from public.instagram_publish_queue where draft_id=d.id and owner_user_id=p_owner_user_id for update;
  if d.kind not in ('instagram_post','reel','story') or exists(select 1 from public.instagram_publish_queue
    where draft_id=d.id and owner_user_id=p_owner_user_id and (status in ('publishing','published') or container_id is not null or instagram_media_id is not null)) then
    raise exception 'approval_invalid_state'; end if;
  update public.mara_drafts set status='rejected' where id=d.id and owner_user_id=p_owner_user_id;
  -- Existing integrity triggers withdraw unclaimed jobs and calendar mirrors.
  update public.mara_pending_actions set status='cancelled',result_summary='Rejected by the owner.',executed_at=clock_timestamp()
    where owner_user_id=p_owner_user_id and status in ('pending','failed')
      and tool_name in ('propose_calendar_item','approve_draft')
      and coalesce(sanitized_arguments->>'sourceDraftId',sanitized_arguments->>'draftId')=d.id::text;
  return true;
end $$;
revoke all on function public.reject_reviewed_post(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.reject_reviewed_post(uuid,uuid,uuid) to service_role;
-- Synchronization also checks the approved version under the draft lock. A
-- cancellation/edit between approval and sync cannot recreate a stale mirror.
create or replace function public.sync_reviewed_post_calendar(p_owner_user_id uuid,p_draft_id uuid,p_content_version bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare d public.mara_drafts%rowtype;
begin
  select * into d from public.mara_drafts where id=p_draft_id and owner_user_id=p_owner_user_id for update;
  if not found or d.status <> 'approved' or d.content_version is distinct from p_content_version
    or d.approved_content_version is distinct from p_content_version then raise exception 'approval_content_changed'; end if;
  if d.proposed_publish_at is not null and d.proposed_publish_at+public.instagram_publish_grace() <= clock_timestamp() then
    perform public.expire_instagram_publish_jobs(clock_timestamp(),p_owner_user_id,p_draft_id);
    return;
  end if;
  insert into public.content_calendar_items(owner_user_id,source_draft_id,title,channel,content,topic,publish_at,status)
    values(p_owner_user_id,d.id,left(d.title,160),case d.kind when 'reel' then 'Reel' when 'story' then 'Story' else 'Instagram' end,
      left(d.content,12000),case d.kind when 'reel' then 'Instagram Reel' when 'story' then 'Instagram Story' else 'Instagram Post' end,
      coalesce(d.proposed_publish_at,clock_timestamp()),case when d.proposed_publish_at is null then 'approved' else 'scheduled' end)
    on conflict(owner_user_id,source_draft_id) do update set title=excluded.title,content=excluded.content,channel=excluded.channel,publish_at=excluded.publish_at,status=excluded.status;
end $$;
revoke all on function public.sync_reviewed_post_calendar(uuid,uuid,bigint) from public,anon,authenticated;
grant execute on function public.sync_reviewed_post_calendar(uuid,uuid,bigint) to service_role;

create or replace function public.enqueue_reviewed_instagram_post(
  p_owner_user_id uuid,p_draft_id uuid,p_content_version bigint,p_calendar_item_id uuid,
  p_media_kind text,p_caption text,p_scheduled_at timestamptz,p_waiting_for_media boolean default false
) returns public.instagram_publish_queue language plpgsql security definer set search_path = '' as $$
declare d public.mara_drafts%rowtype;
begin
  select * into d from public.mara_drafts where id=p_draft_id and owner_user_id=p_owner_user_id for update;
  if not found or d.status <> 'approved' or d.content_version is distinct from p_content_version
    or d.approved_content_version is distinct from p_content_version
    or d.proposed_publish_at is distinct from p_scheduled_at then raise exception 'approval_content_changed'; end if;
  return public.upsert_instagram_publish_queue_item(p_owner_user_id,p_draft_id,p_calendar_item_id,p_media_kind,p_caption,p_scheduled_at,p_waiting_for_media);
end $$;
revoke all on function public.enqueue_reviewed_instagram_post(uuid,uuid,bigint,uuid,text,text,timestamptz,boolean) from public,anon,authenticated;
grant execute on function public.enqueue_reviewed_instagram_post(uuid,uuid,bigint,uuid,text,text,timestamptz,boolean) to service_role;
-- Scheduling updates of standalone calendar entries also expire and compare
-- the target snapshot. Draft-backed items must use their source editor.
create or replace function public.confirm_calendar_update(p_owner_user_id uuid,p_action_id uuid)
returns public.content_calendar_items language plpgsql security definer set search_path = '' as $$
declare a public.mara_pending_actions%rowtype; item public.content_calendar_items%rowtype; at timestamptz; tz text;
begin
  select * into a from public.mara_pending_actions where id=p_action_id and owner_user_id=p_owner_user_id for update;
  if not found or a.status <> 'executing' or a.tool_name <> 'update_calendar_item' then raise exception 'approval_invalid_state'; end if;
  select * into item from public.content_calendar_items where id=(a.sanitized_arguments->>'itemId')::uuid and owner_user_id=p_owner_user_id for update;
  if not found or item.updated_at is distinct from (a.old_value->>'updated_at')::timestamptz then raise exception 'approval_content_changed'; end if;
  if item.source_draft_id is not null then raise exception 'approval_invalid_state'; end if;
  select timezone into tz from public.businesses where owner_user_id=p_owner_user_id;
  if tz is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=tz) then raise exception 'approval_timezone_unavailable'; end if;
  at := coalesce((a.sanitized_arguments->>'publishAt')::timestamptz,item.publish_at);
  if at < clock_timestamp()+public.content_schedule_lead() then raise exception 'approval_schedule_expired'; end if;
  update public.content_calendar_items set
    title=coalesce(a.sanitized_arguments->>'title',title),channel=coalesce(a.sanitized_arguments->>'channel',channel),
    content=coalesce(a.sanitized_arguments->>'content',content),topic=coalesce(a.sanitized_arguments->>'topic',topic),publish_at=at
    where id=item.id and owner_user_id=p_owner_user_id returning * into item;
  update public.mara_pending_actions set status='confirmed',error_summary=null,executed_at=clock_timestamp(),result_summary='Updated the reviewed calendar item.' where id=a.id;
  return item;
end $$;
revoke all on function public.confirm_calendar_update(uuid,uuid) from public,anon,authenticated;
grant execute on function public.confirm_calendar_update(uuid,uuid) to service_role;

-- Expire unsubmitted work only. Active claims and provider containers keep
-- their identities: containers may require read-only reconciliation below.
create or replace function public.expire_instagram_publish_jobs(p_now timestamptz default now(),p_owner_user_id uuid default null,p_draft_id uuid default null)
returns integer language plpgsql security definer set search_path='' as $$
declare affected integer;
begin
  with expired as (
    select q.id from public.instagram_publish_queue q join public.mara_drafts d on d.id=q.draft_id and d.owner_user_id=q.owner_user_id
    where q.instagram_media_id is null
      and (p_owner_user_id is null or q.owner_user_id=p_owner_user_id) and (p_draft_id is null or q.draft_id=p_draft_id)
      and (q.status in ('scheduled','waiting_for_media','permission_required') or (q.status='failed' and q.failure_code='not_approved'))
      and (d.proposed_publish_at is null or d.proposed_publish_at+public.instagram_publish_grace() <= p_now)
    order by q.id limit 500 for update of q skip locked
  )
  update public.instagram_publish_queue q set status='failed',claimed_at=null,
    failure_code='instagram_schedule_expired',failure_message='The scheduled publishing window expired. Choose a new future time or Post now explicitly.'
    from expired where q.id=expired.id;
  get diagnostics affected=row_count;
  return affected;
end $$;
revoke all on function public.expire_instagram_publish_jobs(timestamptz,uuid,uuid) from public,anon,authenticated;
grant execute on function public.expire_instagram_publish_jobs(timestamptz,uuid,uuid) to service_role;

create or replace function public.claim_due_instagram_publish_jobs(
  p_limit integer default 10,
  p_now timestamptz default now(),
  p_max_attempts integer default 5,
  p_stale_after interval default interval '15 minutes'
) returns setof public.instagram_publish_queue
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.expire_instagram_publish_jobs(p_now);
  update public.instagram_publish_queue q set status='failed',claimed_at=null,failure_code='instagram_schedule_expired',
    failure_message='The scheduled publishing window expired. Choose a new future time or Post now explicitly.'
    from public.mara_drafts d where d.id=q.draft_id and d.owner_user_id=q.owner_user_id
      and q.status='publishing' and q.claimed_at < p_now-p_stale_after and q.instagram_media_id is null
      and (d.proposed_publish_at is null or d.proposed_publish_at+public.instagram_publish_grace() <= p_now);
  return query
  with due as (
    select q.id
    from public.instagram_publish_queue q
    join public.mara_drafts d on d.id=q.draft_id and d.owner_user_id=q.owner_user_id
    where q.instagram_media_id is null
      and q.attempts < p_max_attempts
      and (q.scheduled_at <= p_now or (q.container_id is not null and d.proposed_publish_at+public.instagram_publish_grace() <= p_now))
      and (
        q.status = 'scheduled'
        -- 'waiting_for_media' is a truthful UI status, NOT a dead end. It is
        -- written with a future scheduled_at as its retry time, so once that
        -- time is due the item must become claimable again — otherwise a post
        -- whose visual arrived late would be stranded forever.
        or q.status = 'waiting_for_media'
        or (q.status='failed' and q.failure_code='instagram_schedule_expired' and q.container_id is not null)
        or (q.status = 'publishing' and q.claimed_at is not null and q.claimed_at < p_now - p_stale_after)
      )
      and (d.proposed_publish_at <= p_now or q.container_id is not null)
      and (q.container_id is not null or (d.proposed_publish_at is not null and d.proposed_publish_at+public.instagram_publish_grace() > p_now))
    order by q.scheduled_at
    limit greatest(coalesce(p_limit, 10), 1)
    for update of q skip locked
  )
  update public.instagram_publish_queue q
    set status = 'publishing',
        claimed_at = p_now,
        last_attempt_at = p_now,
        attempts = q.attempts + 1
  from due
  where q.id = due.id
  returning q.*;
end;
$$;
create or replace function public.upsert_instagram_publish_queue_item(
  p_owner_user_id uuid,
  p_draft_id uuid,
  p_calendar_item_id uuid,
  p_media_kind text,
  p_caption text,
  p_scheduled_at timestamptz,
  p_waiting_for_media boolean default false
) returns public.instagram_publish_queue
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.instagram_publish_queue;
  v_status text;
  d public.mara_drafts%rowtype;
begin
  if p_media_kind not in ('image', 'reel', 'story') then
    raise exception 'instagram_publish_media_kind_invalid';
  end if;

  select * into d from public.mara_drafts where id=p_draft_id and owner_user_id=p_owner_user_id for update;
  if not found then raise exception 'draft_not_found'; end if;
  v_status := case when p_waiting_for_media then 'waiting_for_media' else 'scheduled' end;

  select * into v_row from public.instagram_publish_queue
    where owner_user_id = p_owner_user_id and draft_id = p_draft_id
    for update;

  -- Never reset a provider identity or resurrect cancelled/withdrawn content.
  if v_row.status in ('published','publishing') or v_row.instagram_media_id is not null or v_row.container_id is not null then return v_row; end if;
  if d.status <> 'approved' or d.approved_content_version is distinct from d.content_version then return v_row; end if;
  if d.proposed_publish_at is null or d.proposed_publish_at+public.instagram_publish_grace() <= clock_timestamp() then
    if v_row.id is not null and v_row.status <> 'cancelled' then
      update public.instagram_publish_queue set status='failed',claimed_at=null,failure_code='instagram_schedule_expired',
        failure_message='The scheduled publishing window expired. Choose a new future time or Post now explicitly.' where id=v_row.id returning * into v_row;
    end if;
    return v_row;
  end if;
  if p_scheduled_at is distinct from d.proposed_publish_at then raise exception 'approval_content_changed'; end if;
  if v_row.status='cancelled' or v_row.failure_code='instagram_schedule_expired' then return v_row; end if;
  if v_row.id is null then
    insert into public.instagram_publish_queue (
      owner_user_id, draft_id, calendar_item_id, media_kind, caption, scheduled_at,
      status, idempotency_key
    ) values (
      p_owner_user_id, p_draft_id, p_calendar_item_id, p_media_kind,
      coalesce(p_caption, ''), p_scheduled_at, v_status,
      'igpub_' || replace(p_draft_id::text, '-', '')
    )
    returning * into v_row;
    return v_row;
  end if;

  if v_row.status in ('published', 'publishing') then
    return v_row;
  end if;

  update public.instagram_publish_queue set
    calendar_item_id = p_calendar_item_id,
    media_kind = p_media_kind,
    caption = coalesce(p_caption, ''),
    scheduled_at = p_scheduled_at,
    status = v_status,
    failure_code = null,
    failure_message = null,
    container_id = null
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;
create or replace function public.fail_instagram_publish_job(
  p_id uuid,
  p_owner_user_id uuid,
  p_failure_code text,
  p_failure_message text,
  p_status text default 'failed',
  p_retry_at timestamptz default null
) returns public.instagram_publish_queue
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.instagram_publish_queue;
  deadline timestamptz;
begin
  if p_status not in ('failed', 'scheduled', 'permission_required', 'waiting_for_media') then
    raise exception 'instagram_publish_failure_status_invalid';
  end if;

  select * into v_row from public.instagram_publish_queue
    where id = p_id and owner_user_id = p_owner_user_id for update;
  if not found then
    raise exception 'instagram_publish_job_not_found';
  end if;
  if v_row.status in ('published','cancelled') then
    return v_row;
  end if;

  select d.proposed_publish_at+public.instagram_publish_grace() into deadline from public.mara_drafts d
    where d.id=v_row.draft_id and d.owner_user_id=p_owner_user_id;
  if p_failure_code='instagram_schedule_expired' or deadline is null or deadline <= clock_timestamp()
    or (p_retry_at is not null and p_retry_at >= deadline) then
    p_status := 'failed'; p_retry_at := null; p_failure_code := 'instagram_schedule_expired';
    p_failure_message := 'The scheduled publishing window expired. Choose a new future time or Post now explicitly. Existing provider submissions are checked read-only.';
  end if;
  if p_status in ('scheduled','waiting_for_media','permission_required') and not exists(
    select 1 from public.mara_drafts d where d.id=v_row.draft_id and d.owner_user_id=p_owner_user_id
      and d.status='approved' and d.content_version=d.approved_content_version) then
    p_status := 'failed'; p_retry_at := null; p_failure_code := 'not_approved';
    p_failure_message := 'This content is no longer approved. Review it before scheduling again.';
  end if;
  update public.instagram_publish_queue set
    status = p_status,
    scheduled_at = coalesce(p_retry_at, scheduled_at),
    claimed_at = null,
    failure_code = left(coalesce(p_failure_code, 'unknown'), 80),
    failure_message = left(coalesce(p_failure_message, ''), 400)
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;
create or replace function public.reschedule_approved_draft(
  p_owner_user_id uuid,
  p_draft_id uuid,
  p_publish_at timestamptz
) returns public.mara_drafts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.mara_drafts;
begin
  if p_owner_user_id is null or p_draft_id is null then
    raise exception 'invalid_reschedule_request';
  end if;
  if p_publish_at is not null and (not isfinite(p_publish_at) or p_publish_at < clock_timestamp()+public.content_schedule_lead()) then raise exception 'approval_schedule_expired'; end if;
  select * into v_row from public.mara_drafts where id=p_draft_id and owner_user_id=p_owner_user_id for update;
  if not found then raise exception 'draft_not_found'; end if;
  if v_row.status <> 'approved' or v_row.approved_content_version is distinct from v_row.content_version then raise exception 'approval_content_changed'; end if;
  perform 1 from public.instagram_publish_queue where draft_id=p_draft_id and owner_user_id=p_owner_user_id for update;
  perform 1 from public.tiktok_publish_queue where draft_id=p_draft_id and owner_user_id=p_owner_user_id for update;
  perform 1 from public.youtube_publish_queue where draft_id=p_draft_id and owner_user_id=p_owner_user_id for update;
  if exists(select 1 from public.instagram_publish_queue where draft_id=p_draft_id and owner_user_id=p_owner_user_id
    and (status in ('publishing','published') or container_id is not null or instagram_media_id is not null))
    or exists(select 1 from public.tiktok_publish_queue where draft_id=p_draft_id and owner_user_id=p_owner_user_id
      and (status in ('posting','provider_processing','published') or tiktok_publish_id is not null))
    or exists(select 1 from public.youtube_publish_queue where draft_id=p_draft_id and owner_user_id=p_owner_user_id
      and (status in ('uploading','provider_processing','published') or upload_session_url is not null or youtube_video_id is not null))
  then raise exception 'approval_invalid_state'; end if;
  -- Changing a time is not consent to resume cancelled work (including Pause all).
  -- Require a fresh explicit approval through the platform editor instead.
  -- Check while all queue rows are locked, before changing the draft or mirrors.
  if p_publish_at is not null and (
    exists(select 1 from public.instagram_publish_queue where draft_id=p_draft_id and owner_user_id=p_owner_user_id and status='cancelled')
    or exists(select 1 from public.tiktok_publish_queue where draft_id=p_draft_id and owner_user_id=p_owner_user_id and status='cancelled')
    or exists(select 1 from public.youtube_publish_queue where draft_id=p_draft_id and owner_user_id=p_owner_user_id and status='cancelled')
  ) then raise exception 'approval_queue_cancelled' using detail='Cancelled publishing requires a fresh explicit platform approval; rescheduling cannot reactivate it.'; end if;
  perform set_config('voom.authorized_reschedule', p_draft_id::text, true);
  update public.mara_drafts set proposed_publish_at = p_publish_at
    where id = p_draft_id and owner_user_id = p_owner_user_id
    returning * into v_row;
  -- Checked on v_row, not FOUND: the PERFORM below resets FOUND.
  perform set_config('voom.authorized_reschedule', '', true);
  if v_row.id is null then raise exception 'draft_not_found'; end if;
  -- Preserve cancelled rows, including their failure/recovery evidence.
  -- Park all other unclaimed rows atomically before releasing the new schedule.
  -- A worker cannot claim the OLD due time between this RPC and queue sync.
  update public.instagram_publish_queue set status=case when p_publish_at is null then 'cancelled' else 'failed' end,
    failure_code='owner_rescheduled_sync_required',failure_message='Owner changed the schedule; synchronize the reviewed content to finish scheduling.',
    attempts=0,claimed_at=null,last_attempt_at=null
    where owner_user_id=p_owner_user_id and draft_id=p_draft_id and status <> 'cancelled' and instagram_media_id is null and container_id is null;
  update public.tiktok_publish_queue set status=case when p_publish_at is null then 'cancelled' else 'failed' end,
    failure_code='owner_rescheduled_sync_required',failure_message='Owner changed the schedule; synchronize the reviewed content to finish scheduling.',attempts=0,claimed_at=null
    where owner_user_id=p_owner_user_id and draft_id=p_draft_id and status <> 'cancelled' and tiktok_publish_id is null;
  update public.youtube_publish_queue set status=case when p_publish_at is null then 'cancelled' else 'failed' end,
    failure_code='owner_rescheduled_sync_required',failure_message='Owner changed the schedule; synchronize the reviewed content to finish scheduling.',attempts=0,claimed_at=null
    where owner_user_id=p_owner_user_id and draft_id=p_draft_id and status <> 'cancelled' and youtube_video_id is null and upload_session_url is null;
  return v_row;
end;
$$;

-- Explicit owner intervention changes the approved schedule, not the retry
-- clock. A new reviewed-version check precedes the authorized reschedule.
create or replace function public.schedule_reviewed_instagram_now(p_owner_user_id uuid,p_draft_id uuid,p_content_version bigint)
returns void language plpgsql security definer set search_path='' as $$
declare d public.mara_drafts%rowtype;
begin
  select * into d from public.mara_drafts where id=p_draft_id and owner_user_id=p_owner_user_id for update;
  if not found or d.kind not in ('instagram_post','reel','story') or p_content_version is null or d.content_version <> p_content_version then raise exception 'approval_content_changed'; end if;
  perform public.reschedule_approved_draft(p_owner_user_id,p_draft_id,clock_timestamp()+public.content_schedule_lead()+interval '1 second');
end $$;
revoke all on function public.schedule_reviewed_instagram_now(uuid,uuid,bigint) from public,anon,authenticated;
grant execute on function public.schedule_reviewed_instagram_now(uuid,uuid,bigint) to service_role;

-- Versioned wrapper for owner rescheduling; the three-argument legacy RPC
-- also retains the final database-time check for every older caller.
create or replace function public.reschedule_reviewed_draft(p_owner_user_id uuid,p_draft_id uuid,p_content_version bigint,p_publish_at timestamptz)
returns public.mara_drafts language plpgsql security definer set search_path='' as $$
declare d public.mara_drafts%rowtype;
begin
  select * into d from public.mara_drafts where id=p_draft_id and owner_user_id=p_owner_user_id for update;
  if not found or p_content_version is null or d.content_version <> p_content_version then raise exception 'approval_content_changed'; end if;
  return public.reschedule_approved_draft(p_owner_user_id,p_draft_id,p_publish_at);
end $$;
revoke all on function public.reschedule_reviewed_draft(uuid,uuid,bigint,timestamptz) from public,anon,authenticated;
grant execute on function public.reschedule_reviewed_draft(uuid,uuid,bigint,timestamptz) to service_role;
commit;
