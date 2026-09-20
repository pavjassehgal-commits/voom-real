-- Email Automation production hardening.
--
-- A provider submission is an external side effect.  Once a worker has
-- durably claimed a run, an expired lease is therefore ambiguous: Resend may
-- have accepted the request even when Voom did not receive its response.  This
-- migration gives each claim a worker-unique token, keeps the provider
-- idempotency key stable for the lifetime of the run, and turns abandoned
-- claims into a terminal needs-attention state instead of resubmitting them.

begin;

alter table public.voom_email_flow_step_runs
  add column if not exists claim_token text;

alter table public.voom_email_flow_step_runs
  drop constraint if exists voom_email_flow_step_runs_claim_token_check;
alter table public.voom_email_flow_step_runs
  add constraint voom_email_flow_step_runs_claim_token_check
  check (claim_token is null or char_length(claim_token) between 16 and 200);

create or replace function public.claim_email_flow_step_run_v2(
  p_owner_user_id uuid,
  p_run_id uuid,
  p_claim_token text,
  p_provider_idempotency_key text
) returns public.voom_email_flow_step_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.voom_email_flow_step_runs;
  v_flow public.voom_email_flows;
  v_enrollment public.voom_email_flow_enrollments;
  v_contact public.contacts;
  v_step public.voom_email_flow_steps;
begin
  if coalesce(p_claim_token, '') = '' or char_length(p_claim_token) < 16 then
    raise exception 'invalid_claim_token';
  end if;
  if coalesce(p_provider_idempotency_key, '') = ''
     or char_length(p_provider_idempotency_key) < 16 then
    raise exception 'invalid_idempotency_key';
  end if;

  select * into v_run
  from public.voom_email_flow_step_runs
  where id = p_run_id and owner_user_id = p_owner_user_id
  for update;
  if not found then
    raise exception 'step_run_not_found';
  end if;

  -- Any in-flight or terminal run belongs to its original worker.  In
  -- particular, an expired `sending` claim is never reclaimed and resent.
  if v_run.status in ('sending', 'accepted', 'delivered', 'skipped') then
    return v_run;
  end if;
  if v_run.status = 'failed' and v_run.attempts >= 3 then
    return v_run;
  end if;
  if v_run.status not in ('scheduled', 'failed') then
    return v_run;
  end if;
  if v_run.scheduled_for > now() then
    return v_run;
  end if;

  select * into v_flow
  from public.voom_email_flows
  where id = v_run.flow_id and owner_user_id = p_owner_user_id
  for update;
  if not found or v_flow.status <> 'active' or v_flow.activated_by is distinct from 'user' then
    raise exception 'flow_not_active';
  end if;

  select * into v_enrollment
  from public.voom_email_flow_enrollments
  where id = v_run.enrollment_id and owner_user_id = p_owner_user_id
  for update;
  if not found or v_enrollment.status <> 'active' then
    raise exception 'enrollment_not_active';
  end if;

  -- Consent and suppression are checked inside the same short transaction as
  -- the claim.  A database/read failure raises and therefore sends nothing.
  select * into v_contact
  from public.contacts
  where id = v_enrollment.contact_id and owner_id = p_owner_user_id;
  if not found
     or v_contact.email is null
     or v_contact.email_status <> 'subscribed'
     or v_contact.email !~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$' then
    raise exception 'recipient_not_eligible';
  end if;
  if exists (
    select 1
    from public.voom_email_suppressions
    where owner_id = p_owner_user_id and lower(email) = lower(v_contact.email)
  ) then
    raise exception 'recipient_suppressed';
  end if;

  if v_run.attempts >= 3 then
    update public.voom_email_flow_step_runs
    set status = 'failed',
        last_error_code = 'retry_limit_reached',
        last_error_message = 'Voom stopped retrying this step after three attempts.'
    where id = v_run.id and owner_user_id = p_owner_user_id
    returning * into v_run;
    return v_run;
  end if;

  select * into v_step
  from public.voom_email_flow_steps
  where owner_user_id = p_owner_user_id
    and flow_id = v_run.flow_id
    and revision = v_run.revision
    and position = v_run.position;
  if not found then
    raise exception 'flow_step_missing';
  end if;

  update public.voom_email_flow_step_runs
  set status = 'sending',
      attempts = attempts + 1,
      claimed_at = now(),
      claim_token = p_claim_token,
      idempotency_key = p_provider_idempotency_key,
      step_id = v_step.id,
      last_error_code = null,
      last_error_message = null,
      content_snapshot = jsonb_build_object(
        'subject', v_step.subject,
        'previewText', v_step.preview_text,
        'body', v_step.body,
        'cta', v_step.cta,
        'ctaUrl', v_step.cta_url,
        'revision', v_step.revision
      )
  where id = v_run.id and owner_user_id = p_owner_user_id
  returning * into v_run;

  return v_run;
end;
$$;

create or replace function public.abandon_stale_email_flow_step_run(
  p_owner_user_id uuid,
  p_run_id uuid,
  p_lease_minutes integer default 10
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.voom_email_flow_step_runs;
  v_lease interval := make_interval(mins => greatest(1, coalesce(p_lease_minutes, 10)));
begin
  select * into v_run
  from public.voom_email_flow_step_runs
  where id = p_run_id and owner_user_id = p_owner_user_id
  for update;
  if not found then
    raise exception 'step_run_not_found';
  end if;

  if v_run.status = 'failed' and v_run.last_error_code = 'provider_outcome_ambiguous' then
    null; -- The current worker already recorded the ambiguity; stop below.
  elsif v_run.status <> 'sending'
     or v_run.claimed_at is null
     or v_run.claimed_at > now() - v_lease then
    return jsonb_build_object('outcome', 'unchanged');
  end if;

  update public.voom_email_flow_step_runs
  set status = 'failed',
      last_error_code = 'provider_outcome_ambiguous',
      last_error_message = 'The provider outcome could not be confirmed. Voom did not retry to avoid a duplicate email.'
  where id = v_run.id and owner_user_id = p_owner_user_id;

  update public.voom_email_flow_enrollments
  set status = 'stopped',
      stop_reason = 'provider_outcome_ambiguous',
      stopped_at = now(),
      next_eligible_at = null
  where id = v_run.enrollment_id
    and owner_user_id = p_owner_user_id
    and status = 'active';

  update public.voom_email_flow_step_runs
  set status = 'skipped', last_error_code = 'enrollment_stopped'
  where owner_user_id = p_owner_user_id
    and enrollment_id = v_run.enrollment_id
    and id <> v_run.id
    and status = 'scheduled';

  insert into public.voom_email_flow_events
    (owner_user_id, flow_id, enrollment_id, kind, detail)
  values
    (p_owner_user_id, v_run.flow_id, v_run.enrollment_id, 'send_failed',
     jsonb_build_object('position', v_run.position, 'reason', 'provider_outcome_ambiguous'));

  return jsonb_build_object('outcome', 'abandoned');
end;
$$;

revoke all on function public.claim_email_flow_step_run_v2(uuid, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.abandon_stale_email_flow_step_run(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_email_flow_step_run_v2(uuid, uuid, text, text)
  to service_role;
grant execute on function public.abandon_stale_email_flow_step_run(uuid, uuid, integer)
  to service_role;

commit;
