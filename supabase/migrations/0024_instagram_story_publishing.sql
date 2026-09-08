-- 0024_instagram_story_publishing.sql
--
-- Instagram Story publishing V1 — a third Instagram content kind (Post / Reel /
-- Story) on the EXISTING auto-publishing system.
--
-- STATUS: PREPARED FOR REVIEW. Do not apply without explicit approval.
--   * Migrations 0001-0023 are untouched; nothing here re-runs or alters them.
--   * Production applies this one new file the same way 0022 was applied.
--
-- What this adds (smallest possible change — no new tables, no new columns):
--   1. public.mara_drafts.kind gains 'story' (every previous kind stays valid).
--   2. public.instagram_publish_queue.media_kind gains 'story'. Stories share
--      the SAME durable queue, states, idempotency, claiming and truthful
--      completion as Posts and Reels.
--   3. public.content_calendar_items.channel gains 'Story' so approved Story
--      drafts mirror onto the existing Content Calendar.
--   4. upsert_instagram_publish_queue_item accepts media_kind 'story'.
--      Same signature (create or replace), so grants survive; they are
--      re-asserted defensively anyway.
--
-- Deliberately NOT changed:
--   * instagram_publish_queue states, uniqueness, claim function, completion
--     and failure functions — they are media-kind agnostic and already
--     guarantee "one publish identity per draft, one media id ever".
--   * post_draft_assets — a Story visual is one private image or video per
--     draft, exactly like a Post or Reel visual today.
--   * claim_due_instagram_publish_jobs — the claim predicate selects by
--     status/schedule, never by media kind, so due Stories are claimed by the
--     same `for update skip locked` path.
--
-- Rollback:
--   delete from public.instagram_publish_queue where media_kind = 'story';
--   delete from public.mara_drafts where kind = 'story';
--   Then re-create the three CHECK constraints without 'story' / 'Story'
--   (existing story rows must be removed first or the narrower check fails).

begin;

-- 1) mara_drafts.kind gains 'story'. The old constraint is dropped by looking
--    it up in pg_constraint (whatever PostgreSQL named it), exactly like
--    migration 0021 did for 'instagram_post'.
do $$
declare c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_attribute att
      on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
    where con.conrelid = 'public.mara_drafts'::regclass
      and con.contype = 'c'
      and att.attname = 'kind'
  loop
    execute format('alter table public.mara_drafts drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.mara_drafts
  add constraint mara_drafts_kind_check
  check (kind in (
    'instagram_caption',
    'instagram_post',
    'reel',
    'story',
    'email',
    'sms',
    'campaign_plan',
    'weekly_calendar'
  ));

-- 2) instagram_publish_queue.media_kind gains 'story'. Same lookup-drop, then
--    a named replacement so future migrations can address it deterministically.
do $$
declare c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_attribute att
      on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
    where con.conrelid = 'public.instagram_publish_queue'::regclass
      and con.contype = 'c'
      and att.attname = 'media_kind'
  loop
    execute format('alter table public.instagram_publish_queue drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.instagram_publish_queue
  add constraint instagram_publish_queue_media_kind_check
  check (media_kind in ('image', 'reel', 'story'));

-- 3) content_calendar_items.channel gains 'Story'.
do $$
declare c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_attribute att
      on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
    where con.conrelid = 'public.content_calendar_items'::regclass
      and con.contype = 'c'
      and att.attname = 'channel'
  loop
    execute format('alter table public.content_calendar_items drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.content_calendar_items
  add constraint content_calendar_items_channel_check
  check (channel in ('Instagram', 'Reel', 'Story', 'Feed', 'Email', 'SMS'));

-- 4) The enqueue RPC accepts 'story'. Identical body to 0022 except the media
--    kind list; the idempotency, one-row-per-draft and published/publishing
--    protections are unchanged.
create or replace function public.upsert_instagram_publish_queue_item(
  p_owner_user_id uuid,
  p_draft_id uuid,
  p_calendar_item_id uuid,
  p_media_kind text,
  p_caption text,
  p_scheduled_at timestamptz
) returns public.instagram_publish_queue
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.instagram_publish_queue;
begin
  if p_media_kind not in ('image', 'reel', 'story') then
    raise exception 'instagram_publish_media_kind_invalid';
  end if;

  select * into v_row from public.instagram_publish_queue
    where owner_user_id = p_owner_user_id and draft_id = p_draft_id
    for update;

  if not found then
    insert into public.instagram_publish_queue (
      owner_user_id, draft_id, calendar_item_id, media_kind, caption, scheduled_at,
      status, idempotency_key
    ) values (
      p_owner_user_id, p_draft_id, p_calendar_item_id, p_media_kind,
      coalesce(p_caption, ''), p_scheduled_at, 'scheduled',
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
    status = 'scheduled',
    failure_code = null,
    failure_message = null,
    container_id = null
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

-- 5) Grants: create or replace keeps the function oid (and therefore the
--    service_role grant), but re-assert it so the state is explicit.
revoke all on function public.upsert_instagram_publish_queue_item(uuid, uuid, uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.upsert_instagram_publish_queue_item(uuid, uuid, uuid, text, text, timestamptz) to service_role;

commit;
