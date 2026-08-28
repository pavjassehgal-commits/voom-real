-- Bind workflow relationships to the same owner, not only to a guessed UUID.
begin;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'mara_drafts_id_owner_key'
      and conrelid = 'public.mara_drafts'::regclass
  ) then
    alter table public.mara_drafts
      add constraint mara_drafts_id_owner_key unique (id, owner_user_id);
  end if;
end $$;

alter table public.mara_drafts
  drop constraint if exists mara_drafts_source_plan_id_fkey;
alter table public.mara_drafts
  add constraint mara_drafts_source_plan_owner_fkey
  foreign key (source_plan_id, owner_user_id)
  references public.marketing_plans (id, owner_user_id)
  on delete restrict;

alter table public.content_calendar_items
  drop constraint if exists content_calendar_items_source_draft_id_fkey;
alter table public.content_calendar_items
  add constraint calendar_source_draft_owner_fkey
  foreign key (source_draft_id, owner_user_id)
  references public.mara_drafts (id, owner_user_id)
  on delete restrict;

commit;
