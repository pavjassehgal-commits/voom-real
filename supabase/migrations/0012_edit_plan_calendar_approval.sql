-- Atomically persist approval-card caption and schedule edits to both the draft
-- source of truth and the pending action snapshot. No calendar row is created here.
begin;

create or replace function public.edit_mara_calendar_approval(
  p_action_id uuid,
  p_content text,
  p_publish_at timestamptz
)
returns void
language plpgsql
security invoker
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

commit;
