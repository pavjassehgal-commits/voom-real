-- Coordinator email-flow authorization, enforced inside the write transaction.
--
-- The app re-checks the owner's authorization immediately before each
-- coordinator email AI call and again immediately before the write. A separate
-- read still leaves a gap between that check and the insert, so the insert of a
-- coordinator-created flow re-checks here, in the same transaction, after
-- taking a share lock on the owner's businesses row. A concurrent pause, mode
-- change or plan change (all UPDATEs of that row) is therefore serialized
-- against the insert: either it commits first and the insert is refused, or the
-- insert commits first and the change applies to everything after it.
--
-- Authorized = not paused AND a confirmed mode the plan includes that allows
-- coordinator proposals: 'assisted' on pro/max, or 'autopilot' on max.
-- Owner-created flows (created_by = 'user') are not affected.

create or replace function public.guard_coordinator_email_flow()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_level text;
  v_plan text;
  v_paused timestamptz;
begin
  if new.created_by is distinct from 'coordinator' then
    return new;
  end if;
  select b.automation_level, coalesce(b.plan, 'free'), b.automation_paused_at
    into v_level, v_plan, v_paused
    from public.businesses b
   where b.owner_user_id = new.owner_user_id
   for share;
  if not found
    or v_paused is not null
    -- coalesce: a NULL mode must refuse, not slip through three-valued logic.
    or not coalesce((v_level = 'assisted' and v_plan in ('pro', 'max')) or (v_level = 'autopilot' and v_plan = 'max'), false) then
    raise exception 'coordinator_flow_not_authorized';
  end if;
  return new;
end;
$$;

drop trigger if exists ensure_coordinator_email_flow_authorized on public.voom_email_flows;
create trigger ensure_coordinator_email_flow_authorized
  before insert on public.voom_email_flows
  for each row execute function public.guard_coordinator_email_flow();

revoke all on function public.guard_coordinator_email_flow() from public, anon, authenticated;
