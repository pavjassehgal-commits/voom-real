-- Campaign v2 production hardening: the database must reject a campaign
-- action that is already stale or outside its container's local date range.
-- The server planner/UI enforce the same rule before this point; this trigger
-- is the last line of defence for retries and direct writes.

create or replace function public.guard_automated_campaign_action_schedule()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  campaign_start timestamptz;
  campaign_end timestamptz;
begin
  -- Let the composite owner/campaign foreign key report cross-workspace rows
  -- using its normal 23503 error rather than changing that contract here.
  select start_at, end_at
    into campaign_start, campaign_end
    from public.voom_campaigns
   where id = new.campaign_id
     and owner_user_id = new.owner_user_id;

  if not found then
    return new;
  end if;

  if new.scheduled_for < now() + interval '10 minutes' then
    raise exception 'campaign_action_schedule_in_past'
      using errcode = '23514';
  end if;

  if campaign_start is not null and new.scheduled_for < campaign_start then
    raise exception 'campaign_action_before_campaign_start'
      using errcode = '23514';
  end if;

  if campaign_end is not null and new.scheduled_for > campaign_end then
    raise exception 'campaign_action_after_campaign_end'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists voom_campaign_action_schedule_guard
  on public.voom_campaign_actions;

create trigger voom_campaign_action_schedule_guard
before insert or update of scheduled_for, campaign_id, owner_user_id
on public.voom_campaign_actions
for each row execute function public.guard_automated_campaign_action_schedule();

grant execute on function public.guard_automated_campaign_action_schedule() to service_role;
revoke execute on function public.guard_automated_campaign_action_schedule() from anon, authenticated;
