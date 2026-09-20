-- Campaigns v3 — the unified multichannel campaign engine.
--
-- Campaigns v2 (0033/0034/0036/0037/0038) already ships the strong parts this
-- version keeps unchanged:
--   * one campaign container (voom_campaigns kind='multi') owning ONE ordered
--     timeline of actions (voom_campaign_actions),
--   * email actions backed by a child email campaign that keeps the whole 0018
--     per-recipient, idempotent delivery lifecycle (and the 0041 Branded Email
--     Engine that sends it),
--   * Instagram actions backed by a Post Studio draft that keeps the whole 0022
--     publish queue, its media guards and its idempotency,
--   * deterministic skeleton -> MARA intelligence -> validated plan, with a
--     deterministic fallback when the provider is unavailable,
--   * schedule guards, sent/published immutability, owner-scoped reads.
--
-- What v3 adds is the smallest coherent set of durable facts those pieces were
-- missing. It is additive and non-destructive:
--
--   1. voom_campaigns.channels — the campaign's AUTHORITATIVE channel
--      selection ('instagram', 'email', or both). A campaign is one workspace
--      with coordinated actions across its selected channels; there is still one
--      campaign model, not one product per channel combination. Every action's
--      channel must belong to its campaign's selection, enforced by a trigger so
--      an invalid combination fails server-side and not only in the client.
--
--   2. voom_campaigns.creation_method — HOW the campaign was created: 'mara'
--      (planned by MARA) or 'self' (the user wrote the actions). This is a
--      different concept from the workspace automation mode
--      (manual/assisted/autopilot on businesses.automation_level) and is never
--      stored in the same column: a MARA-created campaign can run in Manual, and
--      a self-created campaign can run in Autopilot. Neither method grants any
--      execution permission by itself, so the column is deliberately named
--      'self' and never 'manual'.
--
--   3. public.add_campaign_action — append ONE action to an existing campaign.
--      Same owner scoping, same channel-selection rule, same execution
--      identities (email child / Post Studio draft), same schedule guard, and
--      idempotent on (owner_user_id, idempotency_key).
--
--   4. Deterministic backfill so every existing campaign stays readable:
--      containers take their channels from the actions they already own, legacy
--      email drafts take {email}, and retired historical rows keep channels NULL
--      (still readable, never selectable again). Containers created by the MARA
--      builder keep creation_method='mara'; legacy user-written drafts become
--      'self'.
--
-- NOTHING here deletes data, drops a table or a column, retypes a column,
-- rewrites a delivered email, touches migrations 0001-0044, sends email,
-- publishes to Instagram, enqueues paid media, spends a credit, changes a plan
-- price or allowance, or schedules a cron. No new channel value is introduced:
-- the retired messaging channel stays out of every allowlist and out of every
-- new code path, while its historical rows remain readable.

begin;

-- 1) voom_campaigns: the authoritative channel selection ---------------------

alter table public.voom_campaigns
  add column if not exists channels text[];

-- 2) voom_campaigns: how the campaign was created ----------------------------

alter table public.voom_campaigns
  add column if not exists creation_method text not null default 'mara';

-- 3) Deterministic backfill (runs before the new constraints are added) -------

-- 3a) Campaign containers: the channels are the ones their existing actions
--     already use. Stored in the canonical order Instagram, then Email.
update public.voom_campaigns c
   set channels = coalesce(
     (select array_remove(array[
               case when bool_or(f.fam = 'instagram') then 'instagram' end,
               case when bool_or(f.fam = 'email') then 'email' end
             ], null)
        from (
          select case when a.channel = 'email' then 'email' else 'instagram' end as fam
            from public.voom_campaign_actions a
           where a.owner_user_id = c.owner_user_id
             and a.campaign_id = c.id
        ) f),
     array['instagram', 'email']::text[]
   )
 where c.kind = 'multi'
   and c.channels is null;

-- 3b) Every other campaign row is single-channel by kind. Email rows keep
--     {email}; retired historical rows are deliberately left NULL so nothing
--     ever claims a channel selection for them.
update public.voom_campaigns
   set channels = array['email']::text[]
 where kind = 'email'
   and channels is null;

-- 3c) Legacy drafts the user wrote themselves. Containers keep the default
--     'mara' because every existing container was produced by the MARA builder;
--     their email children follow their container.
update public.voom_campaigns
   set creation_method = 'self'
 where parent_campaign_id is null
   and kind <> 'multi'
   and is_automated = false;

-- 4) Constraints --------------------------------------------------------------

-- One or two channels, both from the active allowlist, never a repeat. The
-- allowlist is the only way a channel value enters this column, so a retired or
-- invented channel cannot be stored on any campaign, new or historical.
alter table public.voom_campaigns
  drop constraint if exists voom_campaigns_channels_check;
alter table public.voom_campaigns
  add constraint voom_campaigns_channels_check
  check (
    channels is null
    or (
      cardinality(channels) between 1 and 2
      and channels <@ array['instagram', 'email']::text[]
      and not (cardinality(channels) = 2 and channels[1] = channels[2])
    )
  );

-- A campaign container always has authoritative channels. Only historical rows
-- that predate v3 and carry no container shape may stay NULL.
alter table public.voom_campaigns
  drop constraint if exists voom_campaigns_container_channels_check;
alter table public.voom_campaigns
  add constraint voom_campaigns_container_channels_check
  check (kind <> 'multi' or channels is not null);

alter table public.voom_campaigns
  drop constraint if exists voom_campaigns_creation_method_check;
alter table public.voom_campaigns
  add constraint voom_campaigns_creation_method_check
  check (creation_method in ('mara', 'self'));

-- 5) Generation audit: a self-created campaign is neither MARA nor a fallback --

alter table public.voom_campaign_generations
  drop constraint if exists voom_campaign_generations_provider_check;
alter table public.voom_campaign_generations
  add constraint voom_campaign_generations_provider_check
  check (provider in ('mara', 'fallback', 'self'));

alter table public.voom_campaign_generations
  drop constraint if exists voom_campaign_generations_status_check;
alter table public.voom_campaign_generations
  add constraint voom_campaign_generations_status_check
  check (status in ('completed', 'fallback', 'self'));

alter table public.voom_campaign_generations
  drop constraint if exists voom_campaign_generations_kind_check;
alter table public.voom_campaign_generations
  add constraint voom_campaign_generations_kind_check
  check (kind in ('build', 'action_regenerate', 'action_add'));

-- 6) An action can only run on a channel its campaign selected ----------------
--
-- The action channel CHECK from 0033 already lists the four active channels;
-- this adds the container-level rule so an email action can never be attached to
-- an Instagram-only campaign (or an Instagram action to an email-only one), even
-- on a direct write or a retried request.

create or replace function public.guard_campaign_action_channel()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_channels text[];
  v_family text;
begin
  v_family := case
    when new.channel = 'email' then 'email'
    when new.channel in ('instagram_post', 'instagram_reel', 'instagram_story') then 'instagram'
    else null
  end;

  if v_family is null then
    raise exception 'campaign_action_channel_invalid'
      using errcode = '23514';
  end if;

  select channels
    into v_channels
    from public.voom_campaigns
   where id = new.campaign_id
     and owner_user_id = new.owner_user_id;

  -- A missing container is the composite owner/campaign foreign key's job
  -- (23503); a historical container with no selection keeps its existing rows
  -- readable instead of failing on an unrelated update.
  if not found or v_channels is null then
    return new;
  end if;

  if not (v_family = any (v_channels)) then
    raise exception 'campaign_action_channel_not_selected'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists voom_campaign_action_channel_guard
  on public.voom_campaign_actions;

create trigger voom_campaign_action_channel_guard
before insert or update of channel, campaign_id, owner_user_id
on public.voom_campaign_actions
for each row execute function public.guard_campaign_action_channel();

revoke all on function public.guard_campaign_action_channel() from public, anon, authenticated;
grant execute on function public.guard_campaign_action_channel() to service_role;

-- 7) create_automated_campaign (v3) -------------------------------------------
--
-- Same signature, same idempotency contract, same execution identities and the
-- same "inserts only" guarantee as 0036. v3 additionally:
--   * stores and validates the campaign's authoritative channels,
--   * stores the creation method ('mara' or 'self'),
--   * refuses an action whose channel the campaign did not select,
--   * records a truthful generation row for a self-created campaign
--     (provider/status 'self') and leaves generation_source NULL for it, because
--     no generation layer wrote it,
--   * lets a self-created campaign start with zero actions, so the user can add
--     them one at a time through add_campaign_action. A MARA build still has to
--     produce at least one action.
--
-- It still never sends an email, enqueues an Instagram publish, submits paid
-- media, spends a credit or schedules a cron.

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
  v_actions jsonb := coalesce(p_payload -> 'actions', '[]'::jsonb);
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
  v_method text;
  v_channels text[] := '{}';
  v_selected text;
  v_family text;
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

  -- Creation method: 'mara' unless the caller explicitly says 'self'. It is a
  -- record of who planned the campaign, never of who may execute it.
  v_method := case
    when lower(trim(coalesce(v_campaign ->> 'creationMethod', ''))) = 'self' then 'self'
    else 'mara'
  end;

  -- Authoritative channel selection. Absent means both active channels, which
  -- is exactly what v2 always planned. Anything outside the allowlist is
  -- refused here, so no retired or invented channel can enter a campaign.
  if coalesce(v_campaign -> 'channels', 'null'::jsonb) <> 'null'::jsonb
     and jsonb_typeof(v_campaign -> 'channels') <> 'array' then
    raise exception 'invalid_campaign_channels';
  end if;

  for v_selected in
    select * from jsonb_array_elements_text(
      coalesce(v_campaign -> 'channels', '["instagram","email"]'::jsonb)
    )
  loop
    if v_selected not in ('instagram', 'email') then
      raise exception 'invalid_campaign_channels';
    end if;
    if v_selected = any (v_channels) then
      raise exception 'invalid_campaign_channels';
    end if;
    v_channels := v_channels || v_selected;
  end loop;

  if cardinality(v_channels) not between 1 and 2 then
    raise exception 'invalid_campaign_channels';
  end if;

  select array_agg(c order by case c when 'instagram' then 0 else 1 end)
    into v_channels
    from unnest(v_channels) as c;

  if jsonb_typeof(v_actions) <> 'array' then
    raise exception 'invalid_action_count';
  end if;

  select jsonb_array_length(v_actions) into v_count;
  if v_count is null or v_count > 16 then
    raise exception 'invalid_action_count';
  end if;
  -- A MARA build always produces a plan; a self-created campaign may start
  -- empty and grow one action at a time.
  if v_count < 1 and v_method <> 'self' then
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

  -- A self-created campaign has no generation layer, so generation_source stays
  -- NULL rather than claiming MARA or a deterministic planner wrote it.
  v_source := nullif(trim(coalesce(v_campaign ->> 'generationSource', '')), '');
  if v_source is not null and v_source not in ('deterministic', 'mara') then
    raise exception 'invalid_generation_source';
  end if;

  -- Container.
  insert into public.voom_campaigns (
    owner_user_id, kind, is_automated, name, objective, audience, audience_id,
    goal, start_at, end_at, offer_details, campaign_notes, generated_summary,
    status, build_idempotency_key, strategy, strategy_summary, generation_source,
    channels, creation_method
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
    v_source,
    v_channels,
    v_method
  )
  returning * into v_container;

  -- Exactly one generation row per build key. A replayed build already
  -- returned above, so this insert only ever runs for a genuinely new key.
  insert into public.voom_campaign_generations (
    owner_user_id, campaign_id, action_id, kind, idempotency_key, provider, status, detail
  ) values (
    p_owner_user_id, v_container.id, null, 'build', v_key,
    case when v_method = 'self' then 'self' when v_source = 'mara' then 'mara' else 'fallback' end,
    case when v_method = 'self' then 'self' when v_source = 'mara' then 'completed' else 'fallback' end,
    jsonb_build_object(
      'actionCount', v_count,
      'creationMethod', v_method,
      'channels', to_jsonb(v_channels),
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

    -- The campaign's own selection is authoritative: an action can never widen
    -- the channels its campaign runs on.
    v_family := case when v_channel = 'email' then 'email' else 'instagram' end;
    if not (v_family = any (v_channels)) then
      raise exception 'campaign_action_channel_not_selected';
    end if;

    if v_channel = 'email' then
      -- Email actions reuse the existing email campaign table and its full
      -- 0018 delivery lifecycle. Nothing is sent here.
      insert into public.voom_campaigns (
        owner_user_id, kind, is_automated, parent_campaign_id, name, objective,
        audience, audience_id, subject, preview_text, content, proposed_send_at,
        status, approved_at, channels, creation_method
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
        case when v_status = 'approved' then now() else null end,
        array['email']::text[],
        v_method
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
        case (v_action ->> 'contentSource')
          when 'mara' then 'mara'
          when 'edited' then 'edited'
          else 'deterministic'
        end
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
        case (v_action ->> 'contentSource')
          when 'mara' then 'mara'
          when 'edited' then 'edited'
          else 'deterministic'
        end
      )
      returning id into v_action_id;
    end if;
  end loop;

  return v_container;
end;
$$;

revoke all on function public.create_automated_campaign(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.create_automated_campaign(uuid, jsonb) to service_role;

-- 8) add_campaign_action (v3) -------------------------------------------------
--
-- Appends ONE action to an existing campaign: the "create myself" path builds a
-- campaign up action by action, and a MARA-planned campaign can be extended the
-- same way. It reuses the exact execution identities the build uses (an email
-- child campaign, or a Post Studio draft plus an approved calendar mirror), so
-- delivery and publishing stay on the one existing architecture.
--
-- Idempotent on (owner_user_id, idempotency_key): a replayed request returns
-- the action that already exists and creates nothing twice. The 0037 schedule
-- trigger and the channel guard above both run on this insert, so a past time,
-- a time outside the campaign window, or a channel the campaign did not select
-- are all refused by the database.
--
-- Inserts only: no provider call, no send, no publish, no queue row, no paid
-- media, no credit, no cron.

create or replace function public.add_campaign_action(
  p_owner_user_id uuid,
  p_campaign_id uuid,
  p_payload jsonb
) returns public.voom_campaign_actions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_container public.voom_campaigns;
  v_existing public.voom_campaign_actions;
  v_action public.voom_campaign_actions;
  v_conversation_id uuid;
  v_child public.voom_campaigns;
  v_draft_id uuid;
  v_draft_kind text;
  v_calendar_channel text;
  v_key text;
  v_channel text;
  v_status text;
  v_stage text;
  v_family text;
  v_slot integer;
  v_count integer;
  v_scheduled timestamptz;
  v_content_source text;
begin
  v_key := trim(coalesce(p_payload ->> 'idempotencyKey', ''));
  if char_length(v_key) not between 16 and 200 then
    raise exception 'invalid_action_idempotency_key';
  end if;

  -- Idempotent replay: this owner + key already produced an action.
  select * into v_existing
  from public.voom_campaign_actions
  where owner_user_id = p_owner_user_id
    and idempotency_key = v_key
  for update;

  if found then
    return v_existing;
  end if;

  select * into v_container
  from public.voom_campaigns
  where id = p_campaign_id
    and owner_user_id = p_owner_user_id
    and kind = 'multi'
    and parent_campaign_id is null
  for update;

  if not found then
    raise exception 'campaign_not_found';
  end if;

  v_channel := p_payload ->> 'channel';
  v_status := coalesce(p_payload ->> 'status', 'needs_approval');
  v_stage := coalesce(p_payload ->> 'stage', 'consideration');

  if v_channel not in ('email', 'instagram_post', 'instagram_reel', 'instagram_story') then
    raise exception 'invalid_action_channel';
  end if;
  if v_status not in ('proposed', 'needs_approval', 'approved') then
    raise exception 'invalid_action_status';
  end if;
  if v_stage not in ('awareness', 'consideration', 'conversion', 'retention') then
    raise exception 'invalid_action_stage';
  end if;
  if nullif(trim(coalesce(p_payload ->> 'title', '')), '') is null
     or char_length(trim(p_payload ->> 'title')) > 160 then
    raise exception 'invalid_action_title';
  end if;

  v_scheduled := (nullif(p_payload ->> 'scheduledFor', ''))::timestamptz;
  if v_scheduled is null then
    raise exception 'invalid_action_schedule';
  end if;

  -- The campaign's own selection is authoritative.
  v_family := case when v_channel = 'email' then 'email' else 'instagram' end;
  if v_container.channels is not null and not (v_family = any (v_container.channels)) then
    raise exception 'campaign_action_channel_not_selected';
  end if;

  select count(*)::int, coalesce(max(slot), -1) + 1
    into v_count, v_slot
    from public.voom_campaign_actions
   where owner_user_id = p_owner_user_id
     and campaign_id = v_container.id;

  if v_count >= 16 or v_slot > 15 then
    raise exception 'campaign_action_limit_reached';
  end if;

  v_content_source := case (p_payload ->> 'contentSource')
    when 'mara' then 'mara'
    when 'deterministic' then 'deterministic'
    else 'edited'
  end;

  if v_channel = 'email' then
    insert into public.voom_campaigns (
      owner_user_id, kind, is_automated, parent_campaign_id, name, objective,
      audience, audience_id, subject, preview_text, content, proposed_send_at,
      status, approved_at, channels, creation_method
    ) values (
      p_owner_user_id,
      'email',
      true,
      v_container.id,
      left(trim(p_payload ->> 'title'), 160),
      left(coalesce(p_payload ->> 'purpose', ''), 1000),
      left(coalesce(v_container.audience, ''), 1000),
      nullif(p_payload ->> 'audienceId', '')::uuid,
      nullif(left(p_payload ->> 'subject', 300), ''),
      nullif(left(p_payload ->> 'previewText', 500), ''),
      left(coalesce(p_payload ->> 'body', p_payload ->> 'title'), 12000),
      v_scheduled,
      case when v_status = 'approved' then 'approved' else 'draft' end,
      case when v_status = 'approved' then now() else null end,
      array['email']::text[],
      v_container.creation_method
    )
    returning * into v_child;

    insert into public.voom_campaign_actions (
      owner_user_id, campaign_id, slot, channel, stage, title, purpose,
      scheduled_for, status, email_campaign_id, safety_blockers, idempotency_key,
      mara_content, content_source
    ) values (
      p_owner_user_id, v_container.id, v_slot, v_channel, v_stage,
      left(trim(p_payload ->> 'title'), 160),
      left(coalesce(p_payload ->> 'purpose', ''), 1000),
      v_scheduled, v_status, v_child.id,
      coalesce((select array(select jsonb_array_elements_text(coalesce(p_payload -> 'safetyBlockers', '[]'::jsonb)))), '{}'),
      v_key,
      coalesce(nullif(p_payload -> 'content', 'null'::jsonb), '{}'::jsonb),
      v_content_source
    )
    returning * into v_action;
  else
    select id into v_conversation_id
    from public.mara_conversations
    where owner_user_id = p_owner_user_id and title = 'Automated Campaigns'
    limit 1;

    if v_conversation_id is null then
      insert into public.mara_conversations (owner_user_id, title)
      values (p_owner_user_id, 'Automated Campaigns')
      returning id into v_conversation_id;
    end if;

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
      left(trim(p_payload ->> 'title'), 160),
      left(coalesce(p_payload ->> 'caption', p_payload ->> 'concept', p_payload ->> 'title'), 12000),
      v_scheduled,
      case when v_status = 'approved' then 'approved' else 'draft' end
    )
    returning id into v_draft_id;

    -- Same rule as the build: an approved Instagram action is mirrored to the
    -- calendar as 'approved' only. Without a visual there is no publish-queue
    -- row, so nothing external can happen from this insert.
    if v_status = 'approved' then
      insert into public.content_calendar_items (
        owner_user_id, title, channel, content, topic,
        publish_at, status, source_draft_id
      ) values (
        p_owner_user_id,
        left(trim(p_payload ->> 'title'), 160),
        v_calendar_channel,
        left(coalesce(p_payload ->> 'caption', p_payload ->> 'concept', ''), 12000),
        left(coalesce(p_payload ->> 'purpose', ''), 500),
        v_scheduled,
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
      p_owner_user_id, v_container.id, v_slot, v_channel, v_stage,
      left(trim(p_payload ->> 'title'), 160),
      left(coalesce(p_payload ->> 'purpose', ''), 1000),
      v_scheduled, v_status, v_draft_id,
      coalesce((select array(select jsonb_array_elements_text(coalesce(p_payload -> 'safetyBlockers', '[]'::jsonb)))), '{}'),
      v_key,
      coalesce(nullif(p_payload -> 'content', 'null'::jsonb), '{}'::jsonb),
      v_content_source
    )
    returning * into v_action;
  end if;

  insert into public.voom_campaign_generations (
    owner_user_id, campaign_id, action_id, kind, idempotency_key, provider, status, detail
  ) values (
    p_owner_user_id, v_container.id, v_action.id, 'action_add', v_key,
    case when v_content_source = 'mara' then 'mara' else 'self' end,
    case when v_content_source = 'mara' then 'completed' else 'self' end,
    jsonb_build_object('channel', v_channel, 'slot', v_slot)
  )
  on conflict (owner_user_id, idempotency_key) do nothing;

  return v_action;
end;
$$;

revoke all on function public.add_campaign_action(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.add_campaign_action(uuid, uuid, jsonb) to service_role;

commit;
