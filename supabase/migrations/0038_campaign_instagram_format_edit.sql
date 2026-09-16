-- Campaign detail may change an Instagram action between Post, Reel and Story.
-- This replaces the guarded writer for deployments that already applied 0036;
-- the same body is also present in 0036 for clean installs.

begin;

create or replace function public.update_campaign_action_content(
  p_owner_user_id uuid,
  p_action_id uuid,
  p_patch jsonb,
  p_idempotency_key text default null,
  p_reset_review boolean default false
) returns public.voom_campaign_actions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action public.voom_campaign_actions;
  v_key text := nullif(trim(coalesce(p_idempotency_key, '')), '');
  v_scheduled timestamptz;
  v_content jsonb;
  v_new_channel text;
  v_new_kind text;
  v_new_calendar_channel text;
begin
  if v_key is not null and char_length(v_key) not between 16 and 200 then
    raise exception 'invalid_generation_idempotency_key';
  end if;

  select * into v_action
  from public.voom_campaign_actions
  where id = p_action_id and owner_user_id = p_owner_user_id
  for update;

  if not found then
    raise exception 'campaign_action_not_found';
  end if;

  v_content := coalesce(v_action.mara_content, '{}'::jsonb)
    || coalesce(nullif(p_patch -> 'content', 'null'::jsonb), '{}'::jsonb);

  -- Idempotent replay: this key already produced a generation. Return the row
  -- exactly as it stands; nothing is written a second time.
  if v_key is not null and exists (
    select 1 from public.voom_campaign_generations
    where owner_user_id = p_owner_user_id and idempotency_key = v_key
  ) then
    return v_action;
  end if;

  if v_action.channel = 'email' then
    -- A send that was queued, accepted, delivered or even attempted locks the
    -- content: what the recipient saw must stay what the record says.
    if exists (
      select 1 from public.campaign_sends
      where owner_user_id = p_owner_user_id
        and campaign_id = v_action.email_campaign_id
        and internal_status <> 'skipped'
    ) then
      raise exception 'campaign_action_locked';
    end if;

    update public.voom_campaigns
    set subject = coalesce(nullif(left(p_patch ->> 'subject', 300), ''), subject),
        preview_text = coalesce(nullif(left(p_patch ->> 'previewText', 500), ''), preview_text),
        content = coalesce(nullif(left(p_patch ->> 'body', 12000), ''), content),
        proposed_send_at = coalesce((nullif(p_patch ->> 'scheduledFor', ''))::timestamptz, proposed_send_at),
        -- Content changed, so a previous approval no longer describes it.
        status = case when p_reset_review then 'draft' else status end,
        approved_at = case when p_reset_review then null else approved_at end
    where id = v_action.email_campaign_id and owner_user_id = p_owner_user_id;
  else
    if v_action.draft_id is null then
      raise exception 'campaign_action_not_found';
    end if;

    -- A campaign Instagram format can be changed in place before media or
    -- publishing. Keep the action, Studio draft, calendar mirror and future
    -- generation path on the same format; never leave a Post-labelled action
    -- backed by a Reel draft (or vice versa).
    if nullif(p_patch ->> 'format', '') is not null then
      if (p_patch ->> 'format') not in ('post', 'reel', 'story') then
        raise exception 'instagram_format_invalid';
      end if;
      v_content := jsonb_set(v_content, '{format}', to_jsonb(p_patch ->> 'format'), true);
      if (p_patch ->> 'format') = 'reel' then
        if coalesce(jsonb_typeof(v_content -> 'script'), '') <> 'array' then
          raise exception 'instagram_reel_script_required';
        end if;
        if jsonb_array_length(v_content -> 'script') = 0 then
          raise exception 'instagram_reel_script_required';
        end if;
      else
        if p_patch ? 'content'
          and jsonb_typeof(p_patch -> 'content' -> 'script') = 'array'
          and jsonb_array_length(p_patch -> 'content' -> 'script') > 0 then
          raise exception 'instagram_non_reel_script_forbidden';
        end if;
        -- A format change away from Reel must not leave stale Reel-only data.
        v_content := v_content - 'script';
      end if;
      v_new_channel := case p_patch ->> 'format'
        when 'reel' then 'instagram_reel'
        when 'story' then 'instagram_story'
        else 'instagram_post'
      end;
      if v_new_channel <> v_action.channel then
        if exists (
          select 1 from public.post_draft_assets
          where owner_user_id = p_owner_user_id and draft_id = v_action.draft_id
        ) then
          raise exception 'instagram_format_locked';
        end if;
        if exists (
          select 1 from public.instagram_publish_queue
          where owner_user_id = p_owner_user_id
            and draft_id = v_action.draft_id
            and status in ('publishing', 'published')
        ) then
          raise exception 'campaign_action_locked';
        end if;
        v_new_kind := case v_new_channel
          when 'instagram_reel' then 'reel'
          when 'instagram_story' then 'story'
          else 'instagram_post'
        end;
        v_new_calendar_channel := case v_new_channel
          when 'instagram_reel' then 'Reel'
          when 'instagram_story' then 'Story'
          else 'Instagram'
        end;
        update public.mara_drafts
        set kind = v_new_kind,
            channel = case v_new_kind
              when 'reel' then 'Reel · 9:16'
              when 'story' then 'Instagram Story · 9:16'
              else 'Instagram Post · 4:5'
            end
        where id = v_action.draft_id and owner_user_id = p_owner_user_id;
        update public.content_calendar_items
        set channel = v_new_calendar_channel
        where owner_user_id = p_owner_user_id
          and source_draft_id = v_action.draft_id
          and status in ('draft', 'approved');
        update public.instagram_publish_queue
        set media_kind = case v_new_channel
          when 'instagram_reel' then 'reel'
          when 'instagram_story' then 'story'
          else 'image'
        end
        where owner_user_id = p_owner_user_id
          and draft_id = v_action.draft_id
          and status in ('scheduled', 'waiting_for_media');
      end if;
    end if;

    -- Instagram's own caption limit, enforced here so a rewritten draft can
    -- never be stored in a shape the publisher would have to refuse later.
    if char_length(coalesce(p_patch ->> 'caption', '')) > 2200
      or char_length(coalesce(p_patch ->> 'queueCaption', '')) > 2200 then
      raise exception 'instagram_caption_too_long';
    end if;

    -- Publishing or already published is final. A row still waiting (scheduled
    -- or waiting_for_media) is updated in place so what publishes matches what
    -- the user is looking at.
    if exists (
      select 1 from public.instagram_publish_queue
      where owner_user_id = p_owner_user_id
        and draft_id = v_action.draft_id
        and status in ('publishing', 'published')
    ) then
      raise exception 'campaign_action_locked';
    end if;

    update public.mara_drafts
    set title = coalesce(nullif(left(p_patch ->> 'title', 160), ''), title),
        content = coalesce(nullif(left(p_patch ->> 'caption', 12000), ''), content),
        proposed_publish_at = coalesce((nullif(p_patch ->> 'scheduledFor', ''))::timestamptz, proposed_publish_at),
        status = case when p_reset_review then 'draft' else status end
    where id = v_action.draft_id and owner_user_id = p_owner_user_id;

    -- Keep the existing calendar mirror truthful while it is still a mirror.
    update public.content_calendar_items
    set title = coalesce(nullif(left(p_patch ->> 'title', 160), ''), title),
        content = coalesce(nullif(left(p_patch ->> 'caption', 12000), ''), content),
        publish_at = coalesce((nullif(p_patch ->> 'scheduledFor', ''))::timestamptz, publish_at)
    where owner_user_id = p_owner_user_id
      and source_draft_id = v_action.draft_id
      and status in ('draft', 'approved');

    if p_reset_review then
      -- Regenerated content must be reviewed again: withdraw the mirror and
      -- cancel any queue row that has not started. Published/in-flight rows
      -- were already refused above and are never touched here.
      delete from public.content_calendar_items
      where owner_user_id = p_owner_user_id and source_draft_id = v_action.draft_id;

      update public.instagram_publish_queue
      set status = 'cancelled'
      where owner_user_id = p_owner_user_id
        and draft_id = v_action.draft_id
        and status in ('scheduled', 'waiting_for_media');
    else
      update public.instagram_publish_queue
      set caption = coalesce(nullif(left(p_patch ->> 'queueCaption', 2200), ''), caption),
          scheduled_at = coalesce((nullif(p_patch ->> 'scheduledFor', ''))::timestamptz, scheduled_at)
      where owner_user_id = p_owner_user_id
        and draft_id = v_action.draft_id
        and status in ('scheduled', 'waiting_for_media');
    end if;
  end if;

  -- The structured content was merged before the guarded format checks;
  -- refresh the action row itself with that validated shape.
  v_scheduled := coalesce((nullif(p_patch ->> 'scheduledFor', ''))::timestamptz, v_action.scheduled_for);

  update public.voom_campaign_actions
  set channel = coalesce(v_new_channel, channel),
      title = coalesce(nullif(left(p_patch ->> 'title', 160), ''), title),
      purpose = coalesce(nullif(left(p_patch ->> 'purpose', 1000), ''), purpose),
      scheduled_for = v_scheduled,
      mara_content = v_content,
      content_source = coalesce(nullif(p_patch ->> 'contentSource', ''), content_source),
      safety_blockers = coalesce(
        (select array(select jsonb_array_elements_text(p_patch -> 'safetyBlockers'))),
        safety_blockers
      ),
      status = case when p_reset_review then 'needs_approval' else status end
  where id = v_action.id and owner_user_id = p_owner_user_id
  returning * into v_action;

  if v_key is not null then
    insert into public.voom_campaign_generations (
      owner_user_id, campaign_id, action_id, kind, idempotency_key, provider, status, detail
    ) values (
      p_owner_user_id, v_action.campaign_id, v_action.id,
      -- This writer is only ever reached from per-action edit/regenerate, so the
      -- generation kind is always 'action_regenerate'. The provider column is
      -- what distinguishes MARA-authored content from a deterministic rewrite.
      'action_regenerate',
      v_key,
      case when (p_patch ->> 'contentSource') = 'mara' then 'mara' else 'fallback' end,
      'completed',
      jsonb_build_object('channel', v_action.channel, 'resetReview', p_reset_review)
    )
    on conflict (owner_user_id, idempotency_key) do nothing;
  end if;

  return v_action;
end;
$$;

revoke all on function public.update_campaign_action_content(uuid, uuid, jsonb, text, boolean)
  from public, anon, authenticated;
grant execute on function public.update_campaign_action_content(uuid, uuid, jsonb, text, boolean)
  to service_role;

commit;
