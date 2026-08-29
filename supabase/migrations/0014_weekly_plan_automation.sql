-- Server-only weekly plan automation with one automatic plan per owner/week.
begin;

alter table public.marketing_plans
  add column if not exists automation_week_key date;

create unique index if not exists marketing_plans_owner_automation_week_key
  on public.marketing_plans (owner_user_id, automation_week_key)
  where automation_week_key is not null;

-- The scheduled server process uses the secret service role. Client access and
-- existing owner RLS policies are unchanged.
grant select on table public.profiles, public.businesses,
  public.content_calendar_items, public.voom_campaigns to service_role;
grant select, insert on table public.mara_conversations to service_role;
grant select, insert, update on table public.mara_drafts,
  public.mara_pending_actions, public.mara_tool_runs to service_role;

commit;
