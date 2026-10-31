-- Automation authorization guard for browser-role writes to businesses.
--
-- The businesses_update_own / businesses_insert_own policies (0001) let a
-- signed-in owner write their own row through the API. 0043 and 0059 already
-- stop a browser from changing `plan` or `automation_paused_at`. Nothing
-- stopped it from writing `automation_level` or `allow_automatic_paid_media`
-- directly, so a modified client could store 'autopilot' (or paid-media
-- consent) on a plan that does not include it.
--
-- For a browser-role (anon/authenticated) INSERT, or a CHANGE of the column:
--   automation_level must be NULL, a canonical mode the row's plan includes
--     (free: manual · pro: + assisted · max: + autopilot), or one of the four
--     exact onboarding answers. Those answers grant nothing (the app treats them
--     as unconfirmed, i.e. Manual), and accepting them keeps the onboarding
--     code currently in Production working, so this can be applied BEFORE the
--     matching app deploy without any gap.
--   allow_automatic_paid_media may be turned ON only on a plan with automatic
--     media (max); turning it off is always allowed.
--
-- Unchanged values always pass, so no existing row is rewritten or blocked.
-- Values stored before this guard grant nothing at runtime unless they are a
-- confirmed, plan-included mode (effectiveAutomationMode). Server-side
-- service-role code is unaffected. SECURITY INVOKER on purpose: current_user is
-- the calling API role.

create or replace function public.protect_business_automation_mode()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_plan text := coalesce(new.plan, 'free');
  v_allowed text[];
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  if (tg_op = 'INSERT' or new.automation_level is distinct from old.automation_level)
    and new.automation_level is not null then
    v_allowed := case v_plan
      when 'max' then array['manual', 'assisted', 'autopilot']
      when 'pro' then array['manual', 'assisted']
      else array['manual']
    end || array['I decide everything', 'MARA drafts, I approve', 'MARA drafts and schedules', 'MARA runs it end-to-end'];
    if not (new.automation_level = any (v_allowed)) then
      raise exception 'automation_mode_not_entitled';
    end if;
  end if;

  if (tg_op = 'INSERT' or new.allow_automatic_paid_media is distinct from old.allow_automatic_paid_media)
    and new.allow_automatic_paid_media is true and v_plan <> 'max' then
    raise exception 'automatic_paid_media_not_entitled';
  end if;

  return new;
end;
$$;

drop trigger if exists ensure_business_automation_mode_entitled on public.businesses;
create trigger ensure_business_automation_mode_entitled
  before insert or update on public.businesses
  for each row execute function public.protect_business_automation_mode();

revoke all on function public.protect_business_automation_mode() from public, anon, authenticated;
