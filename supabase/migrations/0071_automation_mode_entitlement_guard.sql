-- Automation mode entitlement guard.
--
-- The businesses_update_own / businesses_insert_own policies (0001) let a
-- signed-in owner write their own row through the API. 0043 and 0059 already
-- stop a browser from changing `plan` or `automation_paused_at`; nothing
-- stopped it from writing `automation_level` directly, so a modified client
-- could store 'autopilot' on a plan that does not include it (runtime guards
-- still refused the work, but the stored mode and every screen were wrong).
--
-- From now on a browser-role (anon/authenticated) INSERT or a CHANGE of
-- automation_level must be NULL or a canonical mode the row's plan includes:
--   free -> manual · pro -> manual, assisted · max -> manual, assisted, autopilot
-- Unchanged values (including existing onboarding answers) are never touched,
-- so no existing business is rewritten. Server-side service-role code is not
-- affected. SECURITY INVOKER on purpose: current_user is the calling API role.

create or replace function public.protect_business_automation_mode()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_allowed text[];
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.automation_level is not distinct from old.automation_level then
    return new;
  end if;
  if new.automation_level is null then
    return new;
  end if;
  v_allowed := case coalesce(new.plan, 'free')
    when 'max' then array['manual', 'assisted', 'autopilot']
    when 'pro' then array['manual', 'assisted']
    else array['manual']
  end;
  if not (new.automation_level = any (v_allowed)) then
    raise exception 'automation_mode_not_entitled';
  end if;
  return new;
end;
$$;

drop trigger if exists ensure_business_automation_mode_entitled on public.businesses;
create trigger ensure_business_automation_mode_entitled
  before insert or update on public.businesses
  for each row execute function public.protect_business_automation_mode();

revoke all on function public.protect_business_automation_mode() from public, anon, authenticated;
