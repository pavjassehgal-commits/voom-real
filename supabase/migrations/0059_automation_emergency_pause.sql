-- Durable owner-scoped emergency pause and explicit resume for MARA automation.
-- Existing user approvals remain valid. Only unclaimed jobs created by
-- Autopilot are cancelled; provider-submitted and published work is preserved.
-- Resume only lifts the pause: it never re-queues cancelled jobs or
-- re-activates paused lifecycle flows, and only the server (service role)
-- can change the pause state — never the browser.
--
-- Approval integrity (Phase 2D): every approval is bound to one content
-- version of the draft. Any change to publishable content — caption, title,
-- format, media brief, platform publishing metadata, the attached image or
-- video, or the schedule — bumps the version and REVOKES the approval inside
-- the database, whichever code path made the change. Unclaimed publishing
-- jobs of a revoked draft are cancelled, and every worker's existing
-- "draft is approved" check now means "approved at the current version".

begin;

alter table public.businesses
  add column if not exists automation_paused_at timestamptz;

alter table public.mara_drafts
  add column if not exists approval_origin text not null default 'user'
  check (approval_origin in ('user', 'autopilot'));

-- Content version of the publishable draft, and the version an approval covers.
alter table public.mara_drafts
  add column if not exists content_version bigint not null default 1 check (content_version >= 1),
  add column if not exists approved_content_version bigint;

-- Existing approvals cover the content as it stands today.
update public.mara_drafts set approved_content_version = content_version
  where status = 'approved' and approved_content_version is null;

-- Preserve provenance for already-created Autopilot approvals using the
-- existing immutable audit key; no title/content heuristic is involved.
update public.mara_drafts d set approval_origin = 'autopilot'
where exists (
  select 1 from public.mara_tool_runs r
  where r.owner_user_id = d.owner_user_id
    and r.idempotency_key = 'workflow-autopilot:' || d.id::text
    and r.status = 'succeeded'
);

create table if not exists public.automation_pause_events (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  business_id uuid not null references public.businesses (id) on delete cascade,
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 200),
  action text not null default 'pause' check (action in ('pause', 'resume')),
  result jsonb not null,
  created_at timestamptz not null default now(),
  unique (owner_user_id, idempotency_key)
);

alter table public.automation_pause_events enable row level security;
revoke all on table public.automation_pause_events from public, anon, authenticated;
grant select on table public.automation_pause_events to authenticated;
grant select, insert on table public.automation_pause_events to service_role;
drop policy if exists "automation_pause_events_select_own" on public.automation_pause_events;
create policy "automation_pause_events_select_own" on public.automation_pause_events
  for select to authenticated using ((select auth.uid()) = owner_user_id);

-- Claim functions update queue rows into these states. Returning NULL from a
-- BEFORE UPDATE trigger omits a paused, still-unclaimed Autopilot row from the
-- UPDATE ... RETURNING result, so a worker never receives it. Existing claimed
-- rows and rows with provider identities remain available to reconciliation.
create or replace function public.guard_paused_automation_claim()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_paused boolean;
  v_origin text;
  v_is_fresh_claim boolean := false;
begin
  if tg_table_name = 'instagram_publish_queue' then
    v_is_fresh_claim := old.status in ('scheduled', 'waiting_for_media')
      and new.status = 'publishing' and old.container_id is null;
  elsif tg_table_name = 'youtube_publish_queue' then
    v_is_fresh_claim := old.status in ('scheduled', 'waiting_for_media')
      and new.status = 'uploading' and old.upload_session_url is null;
  elsif tg_table_name = 'tiktok_publish_queue' then
    v_is_fresh_claim := old.status in ('scheduled', 'waiting_for_media')
      and new.status = 'posting' and old.tiktok_publish_id is null;
  end if;
  if not v_is_fresh_claim then return new; end if;

  select d.approval_origin, (b.automation_paused_at is not null)
    into v_origin, v_paused
  from public.mara_drafts d
  join public.businesses b on b.owner_user_id = d.owner_user_id
  where d.id = new.draft_id and d.owner_user_id = new.owner_user_id;

  if v_origin = 'autopilot' and coalesce(v_paused, false) then return null; end if;
  return new;
end;
$$;

drop trigger if exists instagram_paused_automation_claim_guard on public.instagram_publish_queue;
create trigger instagram_paused_automation_claim_guard
  before update on public.instagram_publish_queue for each row
  execute function public.guard_paused_automation_claim();
drop trigger if exists youtube_paused_automation_claim_guard on public.youtube_publish_queue;
create trigger youtube_paused_automation_claim_guard
  before update on public.youtube_publish_queue for each row
  execute function public.guard_paused_automation_claim();
drop trigger if exists tiktok_paused_automation_claim_guard on public.tiktok_publish_queue;
create trigger tiktok_paused_automation_claim_guard
  before update on public.tiktok_publish_queue for each row
  execute function public.guard_paused_automation_claim();

create or replace function public.pause_all_automation(
  p_owner_user_id uuid,
  p_idempotency_key text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_business public.businesses;
  v_existing jsonb;
  v_existing_action text;
  v_instagram integer := 0;
  v_youtube integer := 0;
  v_tiktok integer := 0;
  v_flows integer := 0;
  v_inflight integer := 0;
  v_published integer := 0;
  v_result jsonb;
begin
  if p_owner_user_id is null or char_length(coalesce(p_idempotency_key, '')) not between 16 and 200 then
    raise exception 'invalid_automation_pause_request';
  end if;
  select result, action into v_existing, v_existing_action from public.automation_pause_events
    where owner_user_id = p_owner_user_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing_action <> 'pause' then raise exception 'automation_idempotency_key_reused'; end if;
    return v_existing;
  end if;

  -- Pause and resume both take this owner row lock first, so they serialize.
  select * into v_business from public.businesses
    where owner_user_id = p_owner_user_id for update;
  if not found then raise exception 'automation_owner_not_found'; end if;

  -- A concurrent replay may have committed while this call waited for the
  -- owner lock. Re-check under that lock so the operation is truly idempotent.
  select result, action into v_existing, v_existing_action from public.automation_pause_events
    where owner_user_id = p_owner_user_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing_action <> 'pause' then raise exception 'automation_idempotency_key_reused'; end if;
    return v_existing;
  end if;

  update public.businesses set automation_paused_at = coalesce(automation_paused_at, now())
    where id = v_business.id;

  update public.voom_email_flows set status = 'paused', paused_at = now()
    where owner_user_id = p_owner_user_id and status = 'active';
  get diagnostics v_flows = row_count;

  update public.instagram_publish_queue q set status = 'cancelled', claimed_at = null
    from public.mara_drafts d
    where q.owner_user_id = p_owner_user_id and q.draft_id = d.id
      and d.owner_user_id = p_owner_user_id and d.approval_origin = 'autopilot'
      and q.status in ('scheduled', 'waiting_for_media') and q.container_id is null;
  get diagnostics v_instagram = row_count;

  update public.youtube_publish_queue q set status = 'cancelled', claimed_at = null
    from public.mara_drafts d
    where q.owner_user_id = p_owner_user_id and q.draft_id = d.id
      and d.owner_user_id = p_owner_user_id and d.approval_origin = 'autopilot'
      and q.status in ('scheduled', 'waiting_for_media') and q.upload_session_url is null;
  get diagnostics v_youtube = row_count;

  update public.tiktok_publish_queue q set status = 'cancelled', claimed_at = null
    from public.mara_drafts d
    where q.owner_user_id = p_owner_user_id and q.draft_id = d.id
      and d.owner_user_id = p_owner_user_id and d.approval_origin = 'autopilot'
      and q.status in ('scheduled', 'waiting_for_media') and q.tiktok_publish_id is null;
  get diagnostics v_tiktok = row_count;

  select count(*) into v_inflight from (
    select q.id from public.instagram_publish_queue q join public.mara_drafts d on d.id=q.draft_id and d.owner_user_id=q.owner_user_id
      where q.owner_user_id=p_owner_user_id and d.approval_origin='autopilot' and q.status <> 'published' and (q.status='publishing' or q.container_id is not null)
    union all
    select q.id from public.youtube_publish_queue q join public.mara_drafts d on d.id=q.draft_id and d.owner_user_id=q.owner_user_id
      where q.owner_user_id=p_owner_user_id and d.approval_origin='autopilot' and q.status <> 'published' and (q.status in ('uploading','provider_processing') or q.upload_session_url is not null)
    union all
    select q.id from public.tiktok_publish_queue q join public.mara_drafts d on d.id=q.draft_id and d.owner_user_id=q.owner_user_id
      where q.owner_user_id=p_owner_user_id and d.approval_origin='autopilot' and q.status <> 'published' and (q.status in ('posting','provider_processing') or q.tiktok_publish_id is not null)
  ) x;
  select count(*) into v_published from (
    select q.id from public.instagram_publish_queue q join public.mara_drafts d on d.id=q.draft_id and d.owner_user_id=q.owner_user_id where q.owner_user_id=p_owner_user_id and d.approval_origin='autopilot' and q.status='published'
    union all select q.id from public.youtube_publish_queue q join public.mara_drafts d on d.id=q.draft_id and d.owner_user_id=q.owner_user_id where q.owner_user_id=p_owner_user_id and d.approval_origin='autopilot' and q.status='published'
    union all select q.id from public.tiktok_publish_queue q join public.mara_drafts d on d.id=q.draft_id and d.owner_user_id=q.owner_user_id where q.owner_user_id=p_owner_user_id and d.approval_origin='autopilot' and q.status='published'
  ) x;

  v_result := jsonb_build_object(
    'alreadyPaused', v_business.automation_paused_at is not null,
    'socialJobsStopped', jsonb_build_object('instagram',v_instagram,'youtube',v_youtube,'tiktok',v_tiktok),
    'lifecycleFlowsPaused', v_flows,
    'untouched', jsonb_build_object('claimedOrSubmitted',v_inflight,'published',v_published)
  );
  insert into public.automation_pause_events(owner_user_id,business_id,idempotency_key,action,result)
    values (p_owner_user_id,v_business.id,p_idempotency_key,'pause',v_result);
  return v_result;
end;
$$;

-- Explicit, owner-requested resume. Only lifts the pause flag. Cancelled
-- Autopilot jobs stay cancelled and paused lifecycle flows stay paused (the
-- owner re-enables each one deliberately). Mode and plan entitlement are NOT
-- changed here and are still enforced at every autonomous boundary.
create or replace function public.resume_all_automation(
  p_owner_user_id uuid,
  p_idempotency_key text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_business public.businesses;
  v_existing jsonb;
  v_existing_action text;
  v_flows_paused integer := 0;
  v_cancelled integer := 0;
  v_result jsonb;
begin
  if p_owner_user_id is null or char_length(coalesce(p_idempotency_key, '')) not between 16 and 200 then
    raise exception 'invalid_automation_resume_request';
  end if;
  select result, action into v_existing, v_existing_action from public.automation_pause_events
    where owner_user_id = p_owner_user_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing_action <> 'resume' then raise exception 'automation_idempotency_key_reused'; end if;
    return v_existing;
  end if;

  select * into v_business from public.businesses
    where owner_user_id = p_owner_user_id for update;
  if not found then raise exception 'automation_owner_not_found'; end if;

  select result, action into v_existing, v_existing_action from public.automation_pause_events
    where owner_user_id = p_owner_user_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing_action <> 'resume' then raise exception 'automation_idempotency_key_reused'; end if;
    return v_existing;
  end if;

  update public.businesses set automation_paused_at = null
    where id = v_business.id and automation_paused_at is not null;

  select count(*) into v_flows_paused from public.voom_email_flows
    where owner_user_id = p_owner_user_id and status = 'paused';
  select count(*) into v_cancelled from (
    select q.id from public.instagram_publish_queue q join public.mara_drafts d on d.id=q.draft_id and d.owner_user_id=q.owner_user_id
      where q.owner_user_id=p_owner_user_id and d.approval_origin='autopilot' and q.status='cancelled'
    union all
    select q.id from public.youtube_publish_queue q join public.mara_drafts d on d.id=q.draft_id and d.owner_user_id=q.owner_user_id
      where q.owner_user_id=p_owner_user_id and d.approval_origin='autopilot' and q.status='cancelled'
    union all
    select q.id from public.tiktok_publish_queue q join public.mara_drafts d on d.id=q.draft_id and d.owner_user_id=q.owner_user_id
      where q.owner_user_id=p_owner_user_id and d.approval_origin='autopilot' and q.status='cancelled'
  ) x;

  v_result := jsonb_build_object(
    'wasPaused', v_business.automation_paused_at is not null,
    'pausedSince', v_business.automation_paused_at,
    'automationMode', v_business.automation_level,
    'plan', v_business.plan,
    'notRestored', jsonb_build_object('cancelledAutopilotJobs', v_cancelled, 'pausedLifecycleFlows', v_flows_paused)
  );
  insert into public.automation_pause_events(owner_user_id,business_id,idempotency_key,action,result)
    values (p_owner_user_id,v_business.id,p_idempotency_key,'resume',v_result);
  return v_result;
end;
$$;

-- The pause state is server-owned. `authenticated` keeps its existing
-- owner-scoped UPDATE on businesses (mode, profile fields), but a browser
-- request can never set or clear automation_paused_at directly, which would
-- bypass the audited, serialized pause/resume functions above. SECURITY
-- INVOKER on purpose: current_user is the calling API role.
create or replace function public.protect_business_automation_pause()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' and new.automation_paused_at is not null then
      raise exception 'automation_pause_server_only';
    elsif tg_op = 'UPDATE' and new.automation_paused_at is distinct from old.automation_paused_at then
      raise exception 'automation_pause_server_only';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists ensure_business_automation_pause_protected on public.businesses;
create trigger ensure_business_automation_pause_protected
  before insert or update on public.businesses
  for each row execute function public.protect_business_automation_pause();

revoke all on function public.guard_paused_automation_claim() from public, anon, authenticated, service_role;
revoke all on function public.pause_all_automation(uuid,text) from public, anon, authenticated;
grant execute on function public.pause_all_automation(uuid,text) to service_role;
revoke all on function public.resume_all_automation(uuid,text) from public, anon, authenticated;
grant execute on function public.resume_all_automation(uuid,text) to service_role;

-- ---------------------------------------------------------------------------
-- Approval integrity (Phase 2D)
-- ---------------------------------------------------------------------------

-- The platform publishing settings kept in content_meta. Planning notes
-- (concept, script) and the TikTok per-post consent record are excluded: the
-- consent has its own fingerprint, re-verified by the TikTok worker.
create or replace function public.draft_publishable_meta(p_meta jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'description', p_meta -> 'description',
    'madeForKids', p_meta -> 'madeForKids',
    'privacy', p_meta -> 'privacy',
    'tiktokPrivacy', p_meta -> 'tiktokPrivacy'
  )
$$;

-- Maintains content_version and enforces: status = 'approved' only while the
-- approval covers the current version. Approval is of the COMPLETE post: any
-- media change, including the first visual arriving after an approval, is a
-- new version that needs a new approval (Autopilot re-evaluates the final
-- content itself; see lib/voom/workflow/media-arrival.ts). One narrow,
-- explicit exception keeps an approval across a version change:
--   * voom.authorized_reschedule = <draft id>: the owner's own reschedule of
--     an approved post (reschedule_approved_draft), schedule-only.
-- The setting is transaction-local and only a service-role function sets it;
-- browsers have no write access to mara_drafts (0050).
create or replace function public.guard_draft_approval_integrity()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_media_bump boolean;
  v_content_changed boolean;
  v_schedule_changed boolean;
  v_keep boolean := false;
begin
  if tg_op = 'INSERT' then
    new.content_version := 1;
    new.approved_content_version := case when new.status = 'approved' then 1 else null end;
    return new;
  end if;

  v_media_bump := new.content_version is distinct from old.content_version;
  v_content_changed := new.title is distinct from old.title
    or new.content is distinct from old.content
    or new.channel is distinct from old.channel
    or new.kind is distinct from old.kind
    or new.social_channel is distinct from old.social_channel
    or new.social_format is distinct from old.social_format
    or new.media_brief is distinct from old.media_brief
    or public.draft_publishable_meta(new.content_meta) is distinct from public.draft_publishable_meta(old.content_meta);
  v_schedule_changed := new.proposed_publish_at is distinct from old.proposed_publish_at;

  -- Versions only ever advance by one per write; callers cannot pick one.
  new.content_version := case
    when v_media_bump or v_content_changed or v_schedule_changed then old.content_version + 1
    else old.content_version end;

  if new.status = 'approved' then
    if old.status is distinct from 'approved' then
      -- An explicit approval covers exactly the version being approved.
      new.approved_content_version := new.content_version;
    elsif new.content_version = old.content_version then
      new.approved_content_version := old.approved_content_version;
    else
      if old.approved_content_version = old.content_version then
        v_keep := v_schedule_changed and not v_content_changed and not v_media_bump
          and current_setting('voom.authorized_reschedule', true) = new.id::text;
      end if;
      if v_keep then
        new.approved_content_version := new.content_version;
      else
        new.status := 'draft';
        new.approved_content_version := null;
        new.approval_origin := 'user';
      end if;
    end if;
  else
    new.approved_content_version := null;
  end if;
  return new;
end;
$$;

drop trigger if exists mara_drafts_approval_integrity on public.mara_drafts;
create trigger mara_drafts_approval_integrity
  before insert or update on public.mara_drafts
  for each row execute function public.guard_draft_approval_integrity();

-- When an approval is revoked (by an edit or explicitly), withdraw every
-- unclaimed publishing job and the calendar mirror. Jobs a worker already
-- claimed, or that hold a provider identity, are left to the workers' own
-- approval re-checks and to reconciliation; published history is untouched.
create or replace function public.withdraw_unapproved_draft_jobs()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'approved' and new.status is distinct from 'approved' then
    update public.instagram_publish_queue set status = 'cancelled', claimed_at = null
      where owner_user_id = new.owner_user_id and draft_id = new.id
        and status in ('scheduled', 'waiting_for_media', 'permission_required') and container_id is null;
    update public.youtube_publish_queue set status = 'cancelled', claimed_at = null
      where owner_user_id = new.owner_user_id and draft_id = new.id
        and status in ('scheduled', 'waiting_for_media', 'needs_declaration', 'permission_required') and upload_session_url is null;
    update public.tiktok_publish_queue set status = 'cancelled', claimed_at = null
      where owner_user_id = new.owner_user_id and draft_id = new.id
        and status in ('scheduled', 'waiting_for_media', 'needs_declaration', 'permission_required') and tiktok_publish_id is null;
    delete from public.content_calendar_items
      where owner_user_id = new.owner_user_id and source_draft_id = new.id;
    -- A campaign action built on this draft needs the owner's review again;
    -- it must never show as approved/scheduled while nothing will publish.
    update public.voom_campaign_actions set status = 'needs_approval'
      where owner_user_id = new.owner_user_id and draft_id = new.id
        and status in ('approved', 'scheduled');
  end if;
  return null;
end;
$$;

drop trigger if exists mara_drafts_withdraw_unapproved_jobs on public.mara_drafts;
-- Deliberately NOT `after update of status`: a column-list trigger fires only
-- when the statement names the column, and revocations are written by the
-- BEFORE trigger on statements that only change content.
create trigger mara_drafts_withdraw_unapproved_jobs
  after update on public.mara_drafts
  for each row execute function public.withdraw_unapproved_draft_jobs();

-- The attached image/video is publishable content: any change — first
-- attach, replacement, removal — bumps the draft's version.
create or replace function public.bump_draft_version_for_media()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_draft uuid;
  v_owner uuid;
begin
  if tg_op = 'UPDATE'
     and new.storage_path is not distinct from old.storage_path
     and new.mime_type is not distinct from old.mime_type
     and new.byte_size is not distinct from old.byte_size
     and new.status is not distinct from old.status
     and new.draft_id is not distinct from old.draft_id then
    return null;
  end if;
  if tg_op = 'DELETE' then
    v_draft := old.draft_id; v_owner := old.owner_user_id;
  else
    v_draft := new.draft_id; v_owner := new.owner_user_id;
  end if;
  update public.mara_drafts set content_version = content_version + 1
    where id = v_draft and owner_user_id = v_owner;
  -- A draft_id move (never done by Voom) must also bump the old draft.
  if tg_op = 'UPDATE' and old.draft_id is distinct from new.draft_id then
    update public.mara_drafts set content_version = content_version + 1
      where id = old.draft_id and owner_user_id = old.owner_user_id;
  end if;
  return null;
end;
$$;

drop trigger if exists post_draft_assets_bump_draft_version on public.post_draft_assets;
create trigger post_draft_assets_bump_draft_version
  after insert or update or delete on public.post_draft_assets
  for each row execute function public.bump_draft_version_for_media();

-- The owner's own reschedule of an approved post keeps its approval (the
-- explicit authorization is already present). Any other schedule change of
-- an approved draft — MARA, a plan rewrite — revokes it.
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

-- Approval-card edits (0012) now also stamp the content version the card
-- shows, so a confirmation can be checked against exactly that version.
create or replace function public.edit_mara_calendar_approval(
  p_action_id uuid,
  p_content text,
  p_publish_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner_id uuid := (select auth.uid());
  v_draft_id uuid;
  v_arguments jsonb;
  v_version bigint;
begin
  if v_owner_id is null then
    raise exception 'authentication_required';
  end if;
  if char_length(trim(p_content)) < 1 or char_length(p_content) > 12000 then
    raise exception 'invalid_content';
  end if;
  if p_publish_at < now() - interval '5 minutes' or p_publish_at > now() + interval '2 years' then
    raise exception 'invalid_publish_at';
  end if;

  select sanitized_arguments, nullif(sanitized_arguments ->> 'sourceDraftId', '')::uuid
    into v_arguments, v_draft_id
  from public.mara_pending_actions
  where id = p_action_id
    and owner_user_id = v_owner_id
    and tool_name = 'propose_calendar_item'
    and status in ('pending', 'failed')
  for update;

  if v_draft_id is null then
    raise exception 'approval_not_editable';
  end if;

  update public.mara_drafts
  set content = trim(p_content), proposed_publish_at = p_publish_at
  where id = v_draft_id and owner_user_id = v_owner_id
  returning content_version into v_version;
  if not found then
    raise exception 'draft_not_found';
  end if;

  v_arguments := jsonb_set(jsonb_set(jsonb_set(v_arguments, '{content}', to_jsonb(trim(p_content))), '{publishAt}', to_jsonb(p_publish_at)), '{contentVersion}', to_jsonb(v_version));

  update public.mara_pending_actions
  set sanitized_arguments = v_arguments,
      new_value = jsonb_set(jsonb_set(jsonb_set(coalesce(new_value, '{}'::jsonb), '{content}', to_jsonb(trim(p_content))), '{publishAt}', to_jsonb(p_publish_at)), '{contentVersion}', to_jsonb(v_version)),
      status = 'pending',
      error_summary = null,
      result_summary = 'Draft and schedule updated. Review them before confirming.'
  where id = p_action_id and owner_user_id = v_owner_id;

  update public.mara_tool_runs
  set sanitized_arguments = v_arguments,
      status = 'pending_confirmation',
      error_summary = null,
      result_summary = 'Draft and schedule edited by the user and awaiting confirmation.'
  where pending_action_id = p_action_id and owner_user_id = v_owner_id;
end;
$$;

revoke all on function public.edit_mara_calendar_approval(uuid, text, timestamptz) from public, anon;
grant execute on function public.edit_mara_calendar_approval(uuid, text, timestamptz) to authenticated;
revoke all on function public.guard_draft_approval_integrity() from public, anon, authenticated;
revoke all on function public.withdraw_unapproved_draft_jobs() from public, anon, authenticated;
revoke all on function public.bump_draft_version_for_media() from public, anon, authenticated;
revoke all on function public.reschedule_approved_draft(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.reschedule_approved_draft(uuid, uuid, timestamptz) to service_role;

commit;
