-- 0030_publish_queue_waiting_for_media.sql
--
-- Missed-publishing lifecycle fix.
--
-- PRODUCTION INCIDENT: an item approved and scheduled for 6:30 PM remained
-- "Scheduled" in every view at 8 PM and never published. Root cause: when a
-- draft was approved before its visual finished generating (the normal case
-- for Reels, whose video jobs complete minutes later), syncPostToPublishQueue
-- treated the missing visual as "cannot publish" and CANCELLED / skipped the
-- queue row. The workflow item still derived "Scheduled" from its approved
-- draft status, so every screen showed a schedule that no worker would ever
-- claim — a silently dead schedule.
--
-- What this changes (smallest possible change, no new tables or columns):
--   1. upsert_instagram_publish_queue_item gains an OPTIONAL trailing
--      parameter p_waiting_for_media (default false). PostgreSQL cannot add a
--      parameter via CREATE OR REPLACE (it would create an overload and
--      six-argument calls would keep binding to the old body), so the old
--      six-argument signature is dropped first and the new one is created
--      with the same first six arguments plus the defaulted seventh — every
--      existing six-argument call keeps working unchanged. The
--      service_role-only EXECUTE grant is re-asserted. When true, a new row
--      is created as 'waiting_for_media' and an existing non-published row is
--      held in 'waiting_for_media' instead of being flipped to 'scheduled'.
--   2. 'waiting_for_media' is already a first-class state: the 0022 claim
--      predicate re-claims those rows when their scheduled time falls due and
--      the publish flow marks media_missing as retryable — so an approved
--      item whose visual arrives late now self-heals and publishes, instead
--      of silently dying.
--
-- Deliberately NOT changed:
--   * claim/complete/fail functions, uniqueness, idempotency and the terminal
--     guard — one publish identity per draft is untouched.
--   * RLS.
--
-- Rollback:
--   drop function if exists public.upsert_instagram_publish_queue_item(uuid, uuid, uuid, text, text, timestamptz, boolean);
--   then recreate the 0022/0024 six-argument body and re-assert its grants.

begin;

drop function if exists public.upsert_instagram_publish_queue_item(uuid, uuid, uuid, text, text, timestamptz);

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

-- Service-role only, exactly like 0022/0024.
revoke all on function public.upsert_instagram_publish_queue_item(uuid, uuid, uuid, text, text, timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.upsert_instagram_publish_queue_item(uuid, uuid, uuid, text, text, timestamptz, boolean) to service_role;

commit;
