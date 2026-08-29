-- Allow one marketing plan to own exactly keyed content drafts while preserving
-- the existing draft -> approval -> calendar ownership chain.
begin;

alter table public.mara_drafts
  add column if not exists source_plan_item_key text;

update public.mara_drafts
set source_plan_item_key = '0'
where source_plan_id is not null and source_plan_item_key is null;

alter table public.mara_drafts
  drop constraint if exists mara_drafts_owner_source_plan_key;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'mara_drafts_owner_plan_item_key'
      and conrelid = 'public.mara_drafts'::regclass
  ) then
    alter table public.mara_drafts
      add constraint mara_drafts_owner_plan_item_key
      unique (owner_user_id, source_plan_id, source_plan_item_key);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'mara_drafts_plan_item_pair_check'
      and conrelid = 'public.mara_drafts'::regclass
  ) then
    alter table public.mara_drafts
      add constraint mara_drafts_plan_item_pair_check check (
        (source_plan_id is null and source_plan_item_key is null)
        or (source_plan_id is not null and char_length(source_plan_item_key) between 1 and 80)
      );
  end if;
end $$;

commit;
