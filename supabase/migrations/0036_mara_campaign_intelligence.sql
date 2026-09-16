-- MARA Campaign Intelligence (Automated Campaigns v2).
--
-- Additive, non-destructive migration. It stores what v2 adds on top of the
-- v1 deterministic skeleton:
--   1. the campaign strategy block MARA reasons out (objective, core message,
--      audience angle, narrative, CTA strategy, sequence rationale) plus the
--      short human-readable "MARA's approach" summary and which layer
--      produced it ('mara' or the deterministic 'fallback');
--   2. the structured per-action content MARA wrote (email subject/preview/
--      body/CTA/destination, Instagram format/concept/hook/caption/CTA/visual
--      direction/Reel script) and which layer produced it;
--   3. public.voom_campaign_generations: one row per MARA generation, keyed by
--      an idempotency key so a repeated Build click or a retried Regenerate
--      can never create a second generation row (or mutate anything twice);
--   4. a guarded writer, public.update_campaign_action_content, used by BOTH
--      "edit this draft" and "Regenerate draft with MARA". It changes ONE
--      action's content, refuses actions that have already been sent or
--      published, and never touches another action, a provider, a queue entry
--      that is already publishing, or any paid media path.
--
-- Nothing here deletes data, sends email, publishes to Instagram, enqueues
-- paid media, spends a credit, or schedules a cron. The email child campaign
-- keeps the 0018 delivery lifecycle and the Instagram draft keeps the 0022
-- publish queue: this migration only stores and edits draft content.

begin;

-- 1) voom_campaigns: the strategy block ---------------------------------------

alter table public.voom_campaigns
  add column if not exists strategy jsonb,
  add column if not exists strategy_summary text,
  add column if not exists generation_source text;

alter table public.voom_campaigns
  drop constraint if exists voom_campaigns_strategy_summary_length_check;
alter table public.voom_campaigns
  add constraint voom_campaigns_strategy_summary_length_check
  check (strategy_summary is null or char_length(strategy_summary) between 1 and 400);

alter table public.voom_campaigns
  drop constraint if exists voom_campaigns_generation_source_check;
alter table public.voom_campaigns
  add constraint voom_campaigns_generation_source_check
  check (generation_source is null or generation_source in ('deterministic', 'mara'));

-- 2) voom_campaign_actions: structured per-action content ----------------------

alter table public.voom_campaign_actions
  add column if not exists mara_content jsonb not null default '{}'::jsonb,
  add column if not exists content_source text not null default 'deterministic';

alter table public.voom_campaign_actions
  drop constraint if exists voom_campaign_actions_content_source_check;
alter table public.voom_campaign_actions
  add constraint voom_campaign_actions_content_source_check
  check (content_source in ('deterministic', 'mara', 'edited'));

-- 3) voom_campaign_generations: idempotent MARA generation audit --------------

create table if not exists public.voom_campaign_generations (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  -- The automated campaign container this generation belongs to.
  campaign_id uuid,
  -- Set for a single-action regeneration; null for a whole-campaign build.
  action_id uuid,
  kind text not null check (kind in ('build', 'action_regenerate')),
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 200),
  -- Which layer produced the content. 'fallback' means MARA was unavailable or
  -- its response was rejected and the deterministic v1 plan was used.
  provider text not null check (provider in ('mara', 'fallback')),
  status text not null default 'completed' check (status in ('completed', 'fallback')),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_user_id),
  -- The idempotency guarantee: one owner + one key = one generation, ever.
  unique (owner_user_id, idempotency_key),
  foreign key (campaign_id, owner_user_id)
    references public.voom_campaigns (id, owner_user_id) on delete cascade,
  foreign key (action_id, owner_user_id)
    references public.voom_campaign_actions (id, owner_user_id) on delete cascade
);

create index if not exists voom_campaign_generations_owner_campaign_idx
  on public.voom_campaign_generations (owner_user_id, campaign_id, created_at desc);

drop trigger if exists set_voom_campaign_generations_updated_at on public.voom_campaign_generations;
create trigger set_voom_campaign_generations_updated_at
  before update on public.voom_campaign_generations
  for each row execute function public.set_updated_at();

alter table public.voom_campaign_generations enable row level security;

revoke all on table public.voom_campaign_generations from public, anon, authenticated;
grant select on table public.voom_campaign_generations to authenticated;
grant select, insert, update on table public.voom_campaign_generations to service_role;

drop policy if exists "voom_campaign_generations_select_own" on public.voom_campaign_generations;
create policy "voom_campaign_generations_select_own" on public.voom_campaign_generations
  for select to authenticated using ((select auth.uid()) = owner_user_id);

-- 4) Atomic, idempotent build function (v2) ------------------------------------
--
-- Same signature and the same idempotency contract as 0033: replaying the SAME
-- build key returns the existing container and never duplicates an action. v2
-- additionally stores the strategy block, the per-action structured content
-- and exactly one generation row per build key. It still only inserts: no
-- provider call, no queue row, no paid media, no send.

create or replace function public.create_automated_campaign(
  p_owner_user_id uuid,
  p_payload jsonb
) returns public.voom_campaigns
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_campaign jsonb := p_payload -> 'campaign';
  v_actions jsonb := p_payload -> 'actions';
  v_key text;
  v_existing public.voom_campaigns;
  v_container public.voom_campaigns;
  v_conversation_id uuid;
  v_action jsonb;
  v_channel text;
  v_status text;
  v_child public.voom_campaigns;
  v_draft_id uuid;
  v_draft_kind text;
  v_calendar_channel text;
  v_action_id uuid;
  v_count integer;
  v_source text;
begin
  v_key := trim(coalesce(v_campaign ->> 'idempotencyKey', ''));
  if char_length(v_key) not between 16 and 200 then
    raise exception 'invalid_build_idempotency_key';
  end if;

  -- Idempotent replay: same owner + same key returns the same container.
  select * into v_existing
  from public.voom_campaigns
  where owner_user_id = p_owner_user_id
    and build_idempotency_key = v_key
    and parent_campaign_id is null
  for update;

  if found then
    return v_existing;
  end if;

  if v_campaign ->> 'name' is null or char_length(trim(v_campaign ->> 'name')) not between 1 and 160 then
    raise exception 'invalid_campaign_name';
  end if;
  if v_campaign ->> 'goal' is null or (v_campaign ->> 'goal') not in
     ('promote_product', 'drive_sales', 'announce', 're_engage', 'awareness') then
    raise exception 'invalid_campaign_goal';
  end if;
  if nullif(v_campaign ->> 'startAt', '') is null or nullif(v_campaign ->> 'endAt', '') is null then
    raise exception 'invalid_campaign_dates';
  end if;

  select jsonb_array_length(v_actions) into v_count;
  if v_count is null or v_count < 1 or v_count > 16 then
    raise exception 'invalid_action_count';
  end if;

  -- The audit conversation all campaign-generated Instagram drafts live in.
  select id into v_conversation_id
  from public.mara_conversations
  where owner_user_id = p_owner_user_id and title = 'Automated Campaigns'
  limit 1;

  if v_conversation_id is null then
    insert into public.mara_conversations (owner_user_id, title)
    values (p_owner_user_id, 'Automated Campaigns')
    returning id into v_conversation_id;
  end if;

  v_source := case when (v_campaign ->> 'generationSource') = 'mara' then 'mara' else 'deterministic' end;

  -- Container.
  insert into public.voom_campaigns (
    owner_user_id, kind, is_automated, name, objective, audience, audience_id,
    goal, start_at, end_at, offer_details, campaign_notes, generated_summary,
    status, build_idempotency_key, strategy, strategy_summary, generation_source
  ) values (
    p_owner_user_id,
    'multi',
    true,
    left(trim(v_campaign ->> 'name'), 160),
    left(coalesce(v_campaign ->> 'notes', ''), 1000),
    left(coalesce(v_campaign ->> 'audience', ''), 1000),
    nullif(v_campaign ->> 'audienceId', '')::uuid,
    v_campaign ->> 'goal',
    (nullif(v_campaign ->> 'startAt', ''))::timestamptz,
    (nullif(v_campaign ->> 'endAt', ''))::timestamptz,
    nullif(left(v_campaign ->> 'offerDetails', 1000), ''),
    nullif(left(v_campaign ->> 'notes', 2000), ''),
    nullif(left(v_campaign ->> 'summary', 2000), ''),
    'draft',
    v_key,
    nullif(v_campaign -> 'strategy', 'null'::jsonb),
    nullif(left(v_campaign ->> 'strategySummary', 400), ''),
    v_source
  )
  returning * into v_container;

  -- Exactly one generation row per build key. A replayed build already
  -- returned above, so this insert only ever runs for a genuinely new key.
  insert into public.voom_campaign_generations (
    owner_user_id, campaign_id, action_id, kind, idempotency_key, provider, status, detail
  ) values (
    p_owner_user_id, v_container.id, null, 'build', v_key,
    case when v_source = 'mara' then 'mara' else 'fallback' end,
    case when v_source = 'mara' then 'completed' else 'fallback' end,
    jsonb_build_object(
      'actionCount', v_count,
      'fallbackSlots', coalesce(v_campaign -> 'fallbackSlots', '[]'::jsonb),
      'performanceUsed', coalesce((v_campaign ->> 'performanceUsed')::boolean, false)
    )
  )
  on conflict (owner_user_id, idempotency_key) do nothing;

  for v_action in select * from jsonb_array_elements(v_actions)
  loop
    v_channel := v_action ->> 'channel';
    v_status := coalesce(v_action ->> 'status', 'proposed');

    if v_channel not in ('email', 'instagram_post', 'instagram_reel', 'instagram_story') then
      raise exception 'invalid_action_channel';
    end if;
    if v_status not in ('proposed', 'needs_approval', 'approved') then
      raise exception 'invalid_action_status';
    end if;

    if v_channel = 'email' then
      -- Email actions reuse the existing email campaign table and its full
      -- 0018 delivery lifecycle. Nothing is sent here.
      insert into public.voom_campaigns (
        owner_user_id, kind, is_automated, parent_campaign_id, name, objective,
        audience, audience_id, subject, preview_text, content, proposed_send_at,
        status, approved_at
      ) values (
        p_owner_user_id,
        'email',
        true,
        v_container.id,
        left(v_action ->> 'title', 160),
        left(coalesce(v_action ->> 'purpose', ''), 1000),
        left(coalesce(v_campaign ->> 'audience', ''), 1000),
        nullif(v_action ->> 'audienceId', '')::uuid,
        nullif(left(v_action ->> 'subject', 300), ''),
        nullif(left(v_action ->> 'previewText', 500), ''),
        left(coalesce(v_action ->> 'body', v_action ->> 'title'), 12000),
        (nullif(v_action ->> 'scheduledFor', ''))::timestamptz,
        case when v_status = 'approved' then 'approved' else 'draft' end,
        case when v_status = 'approved' then now() else null end
      )
      returning * into v_child;

      insert into public.voom_campaign_actions (
        owner_user_id, campaign_id, slot, channel, stage, title, purpose,
        scheduled_for, status, email_campaign_id, safety_blockers, idempotency_key,
        mara_content, content_source
      ) values (
        p_owner_user_id, v_container.id,
        (v_action ->> 'slot')::integer, v_channel, v_action ->> 'stage',
        left(v_action ->> 'title', 160),
        left(coalesce(v_action ->> 'purpose', ''), 1000),
        (nullif(v_action ->> 'scheduledFor', ''))::timestamptz,
        v_status, v_child.id,
        coalesce((select array(select jsonb_array_elements_text(coalesce(v_action -> 'safetyBlockers', '[]'::jsonb)))), '{}'),
        v_action ->> 'idempotencyKey',
        coalesce(nullif(v_action -> 'content', 'null'::jsonb), '{}'::jsonb),
        case when (v_action ->> 'contentSource') = 'mara' then 'mara' else 'deterministic' end
      )
      returning id into v_action_id;

    else
      -- Instagram actions are ordinary Post Studio drafts; they carry no
      -- visual and therefore can never be auto-scheduled or auto-published.
      v_draft_kind := case v_channel
        when 'instagram_reel' then 'reel'
        when 'instagram_story' then 'story'
        else 'instagram_post'
      end;
      v_calendar_channel := case v_channel
        when 'instagram_reel' then 'Reel'
        when 'instagram_story' then 'Story'
        else 'Instagram'
      end;

      insert into public.mara_drafts (
        conversation_id, owner_user_id, kind, channel, title, content,
        proposed_publish_at, status
      ) values (
        v_conversation_id, p_owner_user_id, v_draft_kind,
        case v_draft_kind
          when 'story' then 'Instagram Story · 9:16'
          when 'reel' then 'Reel · 9:16'
          else 'Instagram Post · 4:5'
        end,
        left(v_action ->> 'title', 160),
        left(coalesce(v_action ->> 'caption', v_action ->> 'concept', v_action ->> 'title'), 12000),
        (nullif(v_action ->> 'scheduledFor', ''))::timestamptz,
        case when v_status = 'approved' then 'approved' else 'draft' end
      )
      returning id into v_draft_id;

      -- Autopilot-safe Instagram actions are approved and mirrored to the
      -- calendar as 'approved' (never 'scheduled'): without a visual there is
      -- no publish-queue row, so cron can publish nothing.
      if v_status = 'approved' then
        insert into public.content_calendar_items (
          owner_user_id, title, channel, content, topic,
          publish_at, status, source_draft_id
        ) values (
          p_owner_user_id,
          left(v_action ->> 'title', 160),
          v_calendar_channel,
          left(coalesce(v_action ->> 'caption', v_action ->> 'concept', ''), 12000),
          left(coalesce(v_action ->> 'purpose', ''), 500),
          (nullif(v_action ->> 'scheduledFor', ''))::timestamptz,
          'approved',
          v_draft_id
        )
        on conflict (owner_user_id, source_draft_id) do update set
          title = excluded.title,
          channel = excluded.channel,
          content = excluded.content,
          topic = excluded.topic,
          publish_at = excluded.publish_at,
          status = excluded.status;
      end if;

      insert into public.voom_campaign_actions (
        owner_user_id, campaign_id, slot, channel, stage, title, purpose,
        scheduled_for, status, draft_id, safety_blockers, idempotency_key,
        mara_content, content_source
      ) values (
        p_owner_user_id, v_container.id,
        (v_action ->> 'slot')::integer, v_channel, v_action ->> 'stage',
        left(v_action ->> 'title', 160),
        left(coalesce(v_action ->> 'purpose', ''), 1000),
        (nullif(v_action ->> 'scheduledFor', ''))::timestamptz,
        v_status, v_draft_id,
        coalesce((select array(select jsonb_array_elements_text(coalesce(v_action -> 'safetyBlockers', '[]'::jsonb)))), '{}'),
        v_action ->> 'idempotencyKey',
        coalesce(nullif(v_action -> 'content', 'null'::jsonb), '{}'::jsonb),
        case when (v_action ->> 'contentSource') = 'mara' then 'mara' else 'deterministic' end
      )
      returning id into v_action_id;
    end if;
  end loop;

  return v_container;
end;
$$;

revoke all on function public.create_automated_campaign(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.create_automated_campaign(uuid, jsonb) to service_role;

-- 5) Guarded single-action content writer (edit + regenerate) ------------------
--
-- The ONE path that changes a campaign action's generated content. It:
--   * is owner-scoped and touches exactly one action row (plus that action's
--     own email child campaign / Instagram draft and their existing mirrors);
--   * REFUSES an email action that has a real send in flight or completed, and
--     an Instagram action whose publish queue row is publishing or published —
--     a sent or published action can never be rewritten;
--   * is idempotent on (owner, idempotency_key): replaying the same key is a
--     no-op that returns the current row, so a retried Regenerate cannot apply
--     twice or create a second generation row;
--   * never sends, publishes, queues paid media, or spends a credit.

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

  -- Merge the structured content and refresh the action row itself.
  v_content := coalesce(v_action.mara_content, '{}'::jsonb)
    || coalesce(nullif(p_patch -> 'content', 'null'::jsonb), '{}'::jsonb);
  v_scheduled := coalesce((nullif(p_patch ->> 'scheduledFor', ''))::timestamptz, v_action.scheduled_for);

  update public.voom_campaign_actions
  set title = coalesce(nullif(left(p_patch ->> 'title', 160), ''), title),
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
      case when (p_patch ->> 'contentSource') = 'mara' then 'action_regenerate' else 'action_regenerate' end,
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
