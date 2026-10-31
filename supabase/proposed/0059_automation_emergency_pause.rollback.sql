-- ROLLBACK for 0059_automation_emergency_pause.sql (Phases 2A–2E).
--
-- NOT a migration. Reviewed, never applied. Run only in the SQL editor of a
-- database where 0059 was applied, and only AFTER the application code that
-- uses it has been rolled back (the code reads content_version,
-- approved_content_version, approval_origin and automation_paused_at and
-- calls pause/resume/reschedule RPCs; old code ignores them safely only once
-- the triggers below are gone).
--
-- Order matters: triggers first (so no write is revoked or bumped mid-way),
-- then functions, then the edit_mara_calendar_approval body restored to its
-- 0012 + 0050 form, then schema.
--
-- DATA LOSS (step 4, optional): dropping the columns/table discards approval
-- provenance, content versions, pause state and the pause/resume audit
-- trail. Keep step 4 commented unless a full removal is intended; leaving
-- the inert columns in place is the recommended rollback.

begin;

-- 1. Triggers.
drop trigger if exists post_draft_assets_bump_draft_version on public.post_draft_assets;
drop trigger if exists mara_drafts_withdraw_unapproved_jobs on public.mara_drafts;
drop trigger if exists mara_drafts_approval_integrity on public.mara_drafts;
drop trigger if exists ensure_business_automation_pause_protected on public.businesses;
drop trigger if exists instagram_paused_automation_claim_guard on public.instagram_publish_queue;
drop trigger if exists youtube_paused_automation_claim_guard on public.youtube_publish_queue;
drop trigger if exists tiktok_paused_automation_claim_guard on public.tiktok_publish_queue;

-- 2. Functions introduced by 0059.
drop function if exists public.bump_draft_version_for_media();
drop function if exists public.withdraw_unapproved_draft_jobs();
drop function if exists public.guard_draft_approval_integrity();
drop function if exists public.draft_publishable_meta(jsonb);
drop function if exists public.reschedule_approved_draft(uuid, uuid, timestamptz);
drop function if exists public.protect_business_automation_pause();
drop function if exists public.resume_all_automation(uuid, text);
drop function if exists public.pause_all_automation(uuid, text);
drop function if exists public.guard_paused_automation_claim();

-- 3. Restore the approval-card editor to its pre-0059 body (0012, made
--    SECURITY DEFINER with a pinned search_path by 0050).
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
  where id = v_draft_id and owner_user_id = v_owner_id;
  if not found then
    raise exception 'draft_not_found';
  end if;

  v_arguments := jsonb_set(jsonb_set(v_arguments, '{content}', to_jsonb(trim(p_content))), '{publishAt}', to_jsonb(p_publish_at));

  update public.mara_pending_actions
  set sanitized_arguments = v_arguments,
      new_value = jsonb_set(jsonb_set(coalesce(new_value, '{}'::jsonb), '{content}', to_jsonb(trim(p_content))), '{publishAt}', to_jsonb(p_publish_at)),
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

-- 4. OPTIONAL schema removal (data loss — see header).
-- drop table if exists public.automation_pause_events;
-- alter table public.mara_drafts drop column if exists approved_content_version;
-- alter table public.mara_drafts drop column if exists content_version;
-- alter table public.mara_drafts drop column if exists approval_origin;
-- alter table public.businesses drop column if exists automation_paused_at;
--
-- Paused lifecycle flows and cancelled Autopilot jobs are NOT restored by a
-- rollback; they stay as they are, exactly like a resume.

commit;
