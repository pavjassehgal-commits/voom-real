-- Idempotent linkage for the first plan -> draft -> approval -> calendar workflow.
begin;

alter table public.mara_drafts
  add column if not exists source_plan_id uuid references public.marketing_plans(id) on delete set null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'mara_drafts_owner_source_plan_key'
      and conrelid = 'public.mara_drafts'::regclass
  ) then
    alter table public.mara_drafts
      add constraint mara_drafts_owner_source_plan_key unique (owner_user_id, source_plan_id);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'calendar_owner_source_draft_key'
      and conrelid = 'public.content_calendar_items'::regclass
  ) then
    alter table public.content_calendar_items
      add constraint calendar_owner_source_draft_key unique (owner_user_id, source_draft_id);
  end if;
end $$;

commit;
