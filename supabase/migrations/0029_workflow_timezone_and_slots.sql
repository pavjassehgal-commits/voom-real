-- Cadence-aware rolling content workflow: account timezone + slot-keyed items.
--
-- Additive and owner/RLS safe. No production data is removed, no table is
-- dropped, no existing policy or grant is weakened.
--
--   1. public.businesses.timezone — the account/business timezone used by
--      every date source in the workflow. Existing rows are backfilled to
--      'Asia/Dubai', which is what those accounts were already assumed to be.
--   2. public.mara_drafts.source_plan_item_key already exists (0013) and is
--      now used to hold the LOCAL SLOT DATE (YYYY-MM-DD). The existing unique
--      constraint (owner_user_id, source_plan_id, source_plan_item_key) is the
--      duplicate-plan guard for the rolling planner, so nothing new is needed.
--   3. Indexes that make the workflow read model cheap.
--   4. The service role can read post_draft_assets/media rows it already
--      writes, so the scheduled worker can resolve workflow status.

begin;

-- 1) Account timezone.
alter table public.businesses
  add column if not exists timezone text;

update public.businesses
set timezone = 'Asia/Dubai'
where timezone is null;

alter table public.businesses
  alter column timezone set default 'Asia/Dubai';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'businesses_timezone_check' and conrelid = 'public.businesses'::regclass
  ) then
    alter table public.businesses
      add constraint businesses_timezone_check
      check (timezone is null or char_length(timezone) between 3 and 64);
  end if;
end $$;

-- 2) Read-model indexes for the rolling plan horizon.
create index if not exists mara_drafts_owner_plan_slot_idx
  on public.mara_drafts (owner_user_id, source_plan_id, source_plan_item_key)
  where source_plan_id is not null;

create index if not exists mara_drafts_owner_publish_idx
  on public.mara_drafts (owner_user_id, proposed_publish_at);

-- 3) Server-only reads the rolling worker needs. Authenticated grants and all
--    owner RLS policies are unchanged.
grant select on table public.post_draft_assets to service_role;
grant select on table public.instagram_publish_queue to service_role;
grant select, update on table public.marketing_plans to service_role;

commit;
