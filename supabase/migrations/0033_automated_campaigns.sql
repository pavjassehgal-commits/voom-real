-- Automated Campaigns v1.
--
-- Additive, non-destructive migration. It:
--   1. turns public.voom_campaigns into a container table for MARA-built
--      multi-channel campaigns WITHOUT touching any legacy row:
--        * kind gains 'multi' (the automated campaign container);
--          'sms' stays valid so historical SMS campaigns remain readable;
--        * automated containers carry goal/start/end/offer/notes/summary;
--        * email actions live as ordinary kind='email' child campaigns and
--          keep reusing the 0018 per-recipient, idempotent send lifecycle;
--   2. adds public.voom_campaign_actions: ONE ordered timeline of planned
--      actions (email + Instagram Post/Reel/Story) per automated campaign.
--
-- Nothing here deletes data, narrows an existing SMS value, sends, publishes,
-- enqueues paid media, or schedules a cron. SMS remains internally readable
-- (read-only in the app); no new SMS value can be produced by the planner,
-- whose action channel CHECK lists email + Instagram channels only.

begin;

-- 1) voom_campaigns: automated container columns --------------------------------

alter table public.voom_campaigns
  add column if not exists is_automated boolean not null default false,
  add column if not exists goal text,
  add column if not exists start_at timestamptz,
  add column if not exists end_at timestamptz,
  add column if not exists offer_details text,
  add column if not exists campaign_notes text,
  add column if not exists generated_summary text,
  add column if not exists parent_campaign_id uuid,
  add column if not exists build_idempotency_key text;

-- kind gains 'multi'. The existing SMS literal is deliberately retained:
-- historical SMS campaigns must keep loading. Constraint is dropped by name
-- lookup (same technique as 0021/0024) so this is idempotent.
do $$
declare c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_attribute att
      on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
    where con.conrelid = 'public.voom_campaigns'::regclass
      and con.contype = 'c'
      and att.attname = 'kind'
  loop
    execute format('alter table public.voom_campaigns drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.voom_campaigns
  add constraint voom_campaigns_kind_check
  check (kind in ('email', 'sms', 'multi'));

alter table public.voom_campaigns
  drop constraint if exists voom_campaigns_goal_check;
alter table public.voom_campaigns
  add constraint voom_campaigns_goal_check
  check (goal is null or goal in (
    'promote_product', 'drive_sales', 'announce', 're_engage', 'awareness'
  ));

alter table public.voom_campaigns
  drop constraint if exists voom_campaigns_automated_shape_check;
alter table public.voom_campaigns
  add constraint voom_campaigns_automated_shape_check
  check (
    -- An automated top-level container must be multi-channel and carry goal + dates.
    (parent_campaign_id is null and (
      is_automated = false
      or (kind = 'multi' and goal is not null and start_at is not null and end_at is not null and end_at >= start_at)
    ))
    -- An automated child action campaign is email-only (never SMS).
    or (parent_campaign_id is not null and is_automated = true and kind = 'email')
  );

alter table public.voom_campaigns
  drop constraint if exists voom_campaigns_offer_length_check;
alter table public.voom_campaigns
  add constraint voom_campaigns_offer_length_check
  check (offer_details is null or char_length(offer_details) <= 1000);

alter table public.voom_campaigns
  drop constraint if exists voom_campaigns_notes_length_check;
alter table public.voom_campaigns
  add constraint voom_campaigns_notes_length_check
  check (campaign_notes is null or char_length(campaign_notes) <= 2000);

alter table public.voom_campaigns
  drop constraint if exists voom_campaigns_summary_length_check;
alter table public.voom_campaigns
  add constraint voom_campaigns_summary_length_check
  check (generated_summary is null or char_length(generated_summary) <= 2000);

alter table public.voom_campaigns
  drop constraint if exists voom_campaigns_build_key_length_check;
alter table public.voom_campaigns
  add constraint voom_campaigns_build_key_length_check
  check (build_idempotency_key is null or char_length(build_idempotency_key) between 16 and 200);

alter table public.voom_campaigns
  drop constraint if exists voom_campaigns_parent_fk;
alter table public.voom_campaigns
  add constraint voom_campaigns_parent_fk
  foreign key (parent_campaign_id, owner_user_id)
  references public.voom_campaigns (id, owner_user_id) on delete cascade;

create unique index if not exists voom_campaigns_build_idempotency_idx
  on public.voom_campaigns (owner_user_id, build_idempotency_key)
  where build_idempotency_key is not null;

create index if not exists voom_campaigns_parent_idx
  on public.voom_campaigns (owner_user_id, parent_campaign_id)
  where parent_campaign_id is not null;

-- 2) voom_campaign_actions ---------------------------------------------------

create table if not exists public.voom_campaign_actions (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  campaign_id uuid not null,
  slot integer not null check (slot between 0 and 15),
  channel text not null check (channel in (
    'email', 'instagram_post', 'instagram_reel', 'instagram_story'
  )),
  stage text not null check (stage in ('awareness', 'consideration', 'conversion', 'retention')),
  title text not null check (char_length(title) between 1 and 160),
  purpose text not null default '' check (char_length(purpose) <= 1000),
  scheduled_for timestamptz not null,
  status text not null default 'proposed' check (status in (
    'proposed', 'needs_approval', 'approved', 'scheduled', 'executed', 'failed', 'skipped'
  )),
  -- Email action: the child email campaign carrying the deliverable.
  email_campaign_id uuid,
  -- Instagram action: the mara_drafts Post/Reel/Story draft.
  draft_id uuid,
  safety_blockers text[] not null default '{}',
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_user_id),
  unique (owner_user_id, campaign_id, slot),
  unique (owner_user_id, idempotency_key),
  unique (owner_user_id, email_campaign_id),
  unique (owner_user_id, draft_id),
  foreign key (campaign_id, owner_user_id)
    references public.voom_campaigns (id, owner_user_id) on delete cascade,
  foreign key (email_campaign_id, owner_user_id)
    references public.voom_campaigns (id, owner_user_id) on delete cascade,
  foreign key (draft_id, owner_user_id)
    references public.mara_drafts (id, owner_user_id) on delete cascade,
  -- Each channel links exactly its own execution identity.
  constraint voom_campaign_actions_email_link_check
    check (
      (channel = 'email' and email_campaign_id is not null and draft_id is null)
      or
      (channel <> 'email' and draft_id is not null and email_campaign_id is null)
    )
);

create index if not exists voom_campaign_actions_owner_campaign_idx
  on public.voom_campaign_actions (owner_user_id, campaign_id, slot);

drop trigger if exists set_voom_campaign_actions_updated_at on public.voom_campaign_actions;
create trigger set_voom_campaign_actions_updated_at
  before update on public.voom_campaign_actions
  for each row execute function public.set_updated_at();

alter table public.voom_campaign_actions enable row level security;

revoke all on table public.voom_campaign_actions from public, anon, authenticated;
grant select on table public.voom_campaign_actions to authenticated;
grant select, insert, update on table public.voom_campaign_actions to service_role;

drop policy if exists "voom_campaign_actions_select_own" on public.voom_campaign_actions;
create policy "voom_campaign_actions_select_own" on public.voom_campaign_actions
  for select to authenticated using ((select auth.uid()) = owner_user_id);

-- 3) Atomic, idempotent build function ----------------------------------------
--
-- Creates one automated campaign container plus its email child campaigns,
-- Instagram drafts, approved calendar mirrors (Autopilot-safe only) and the
-- ordered action rows — in one transactional, owner-scoped call.
--
-- Idempotent on (owner_user_id, idempotency_key): replaying the SAME build
-- returns the existing container and never duplicates an action. The function
-- only inserts; it never calls a provider, a queue, or a paid media path.

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

  -- Container.
  insert into public.voom_campaigns (
    owner_user_id, kind, is_automated, name, objective, audience, audience_id,
    goal, start_at, end_at, offer_details, campaign_notes, generated_summary,
    status, build_idempotency_key
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
    v_key
  )
  returning * into v_container;

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
        scheduled_for, status, email_campaign_id, safety_blockers, idempotency_key
      ) values (
        p_owner_user_id, v_container.id,
        (v_action ->> 'slot')::integer, v_channel, v_action ->> 'stage',
        left(v_action ->> 'title', 160),
        left(coalesce(v_action ->> 'purpose', ''), 1000),
        (nullif(v_action ->> 'scheduledFor', ''))::timestamptz,
        v_status, v_child.id,
        coalesce((select array(select jsonb_array_elements_text(coalesce(v_action -> 'safetyBlockers', '[]'::jsonb)))), '{}'),
        v_action ->> 'idempotencyKey'
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
        scheduled_for, status, draft_id, safety_blockers, idempotency_key
      ) values (
        p_owner_user_id, v_container.id,
        (v_action ->> 'slot')::integer, v_channel, v_action ->> 'stage',
        left(v_action ->> 'title', 160),
        left(coalesce(v_action ->> 'purpose', ''), 1000),
        (nullif(v_action ->> 'scheduledFor', ''))::timestamptz,
        v_status, v_draft_id,
        coalesce((select array(select jsonb_array_elements_text(coalesce(v_action -> 'safetyBlockers', '[]'::jsonb)))), '{}'),
        v_action ->> 'idempotencyKey'
      )
      returning id into v_action_id;
    end if;
  end loop;

  return v_container;
end;
$$;

revoke all on function public.create_automated_campaign(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.create_automated_campaign(uuid, jsonb) to service_role;

-- 4) Action-level approval (email children). Owner-scoped, approval state only;
--    this never sends. The 0018 explicit delivery POST remains the only send.
create or replace function public.set_campaign_action_email_approval(
  p_owner_user_id uuid,
  p_action_id uuid,
  p_action text
) returns public.voom_campaign_actions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action public.voom_campaign_actions;
  v_decision text := lower(trim(p_action));
begin
  if v_decision not in ('approve', 'reject') then
    raise exception 'invalid_action_decision';
  end if;

  select * into v_action
  from public.voom_campaign_actions
  where id = p_action_id and owner_user_id = p_owner_user_id and channel = 'email'
  for update;

  if not found then
    raise exception 'campaign_action_not_found';
  end if;

  update public.voom_campaigns
  set status = case when v_decision = 'approve' then 'approved' else 'rejected' end,
      approved_at = case when v_decision = 'approve' then coalesce(approved_at, now()) else null end
  where id = v_action.email_campaign_id
    and owner_user_id = p_owner_user_id;

  update public.voom_campaign_actions
  set status = case when v_decision = 'approve' then 'approved' else 'skipped' end
  where id = v_action.id and owner_user_id = p_owner_user_id
  returning * into v_action;

  return v_action;
end;
$$;

revoke all on function public.set_campaign_action_email_approval(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.set_campaign_action_email_approval(uuid, uuid, text) to service_role;

commit;
