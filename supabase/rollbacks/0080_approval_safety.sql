-- 0080 rollback: REVERT THE DEPENDENT APPLICATION FIRST.
-- Restores the production function bodies; removes only 0080 helpers.
-- No draft, approval, calendar, queue or published row is updated or deleted.
-- Expired failure records remain terminal; rollback never requeues them.
begin;
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
  return query
  with due as (
    select q.id
    from public.instagram_publish_queue q
    where q.instagram_media_id is null
      and q.attempts < p_max_attempts
      and q.scheduled_at <= p_now
      and (
        q.status = 'scheduled'
        -- 'waiting_for_media' is a truthful UI status, NOT a dead end. It is
        -- written with a future scheduled_at as its retry time, so once that
        -- time is due the item must become claimable again — otherwise a post
        -- whose visual arrived late would be stranded forever.
        or q.status = 'waiting_for_media'
        or (q.status = 'publishing' and q.claimed_at is not null and q.claimed_at < p_now - p_stale_after)
      )
    order by q.scheduled_at
    limit greatest(coalesce(p_limit, 10), 1)
    for update skip locked
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
begin
  if p_status not in ('failed', 'scheduled', 'permission_required', 'waiting_for_media') then
    raise exception 'instagram_publish_failure_status_invalid';
  end if;

  select * into v_row from public.instagram_publish_queue
    where id = p_id and owner_user_id = p_owner_user_id for update;
  if not found then
    raise exception 'instagram_publish_job_not_found';
  end if;
  if v_row.status = 'published' then
    return v_row;
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
begin
  if p_media_kind not in ('image', 'reel', 'story') then
    raise exception 'instagram_publish_media_kind_invalid';
  end if;

  v_status := case when p_waiting_for_media then 'waiting_for_media' else 'scheduled' end;

  select * into v_row from public.instagram_publish_queue
    where owner_user_id = p_owner_user_id and draft_id = p_draft_id
    for update;

  if not found then
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
  perform set_config('voom.authorized_reschedule', p_draft_id::text, true);
  update public.mara_drafts set proposed_publish_at = p_publish_at
    where id = p_draft_id and owner_user_id = p_owner_user_id
    returning * into v_row;
  -- Checked on v_row, not FOUND: the PERFORM below resets FOUND.
  perform set_config('voom.authorized_reschedule', '', true);
  if v_row.id is null then raise exception 'draft_not_found'; end if;
  return v_row;
end;
$$;
drop function if exists public.reschedule_reviewed_draft(uuid,uuid,bigint,timestamptz);
drop function if exists public.schedule_reviewed_instagram_now(uuid,uuid,bigint);
drop function if exists public.confirm_calendar_update(uuid,uuid);
drop function if exists public.enqueue_reviewed_instagram_post(uuid,uuid,bigint,uuid,text,text,timestamptz,boolean);
drop function if exists public.sync_reviewed_post_calendar(uuid,uuid,bigint);
drop function if exists public.reject_reviewed_post(uuid,uuid,uuid);
drop function if exists public.confirm_calendar_proposal(uuid,uuid);
drop function if exists public.approve_reviewed_post(uuid,uuid,bigint,text,uuid,uuid);
drop function if exists public.expire_instagram_publish_jobs(timestamptz,uuid,uuid);
drop function if exists public.instagram_publish_grace();
drop function if exists public.content_schedule_lead();
commit;
