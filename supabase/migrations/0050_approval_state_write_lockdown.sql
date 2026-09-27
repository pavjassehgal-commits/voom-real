-- 0050: Approval-state write lockdown (production hardening).
--
-- Before this migration the `authenticated` role held INSERT/UPDATE (and for
-- the calendar, DELETE) on the tables that carry approval and lifecycle state.
-- RLS only checked ownership, so a signed-in user could call the Supabase REST
-- API directly with their own token and, for example, set
-- voom_campaigns.status = 'approved', mark a draft approved, or confirm a
-- pending action — skipping the server-side validation, schedule guards and
-- safety checks that the Voom API routes enforce.
--
-- Every Voom write path to these tables now runs on the server with the
-- service-role client, always filtered by owner_user_id. The browser keeps
-- read access to its own rows (RLS unchanged). This matches the pattern used
-- by the newer tables (email flows, campaign actions, publish queues).
--
-- Additive and idempotent. Rollback: re-run the original grants from
-- 0003 / 0014 / 0018.

begin;

-- 1. Authenticated users keep SELECT (owner-scoped by RLS) and lose writes.
revoke insert, update, delete on table
  public.voom_campaigns,
  public.mara_pending_actions,
  public.mara_tool_runs,
  public.mara_drafts,
  public.content_calendar_items
from anon, authenticated;

grant select on table
  public.voom_campaigns,
  public.mara_pending_actions,
  public.mara_tool_runs,
  public.mara_drafts,
  public.content_calendar_items
to authenticated;

-- 2. The server (service role) owns every write.
grant select, insert, update, delete on table
  public.voom_campaigns,
  public.mara_pending_actions,
  public.mara_tool_runs,
  public.mara_drafts,
  public.content_calendar_items
to service_role;

-- 3. The approval-card editor (0012) derives the owner from auth.uid() and can
--    only move an owned pending/failed calendar approval back to 'pending'
--    with new content. It ran as SECURITY INVOKER, which needed the table
--    grants revoked above; it now runs as SECURITY DEFINER with a pinned
--    search_path. Its owner check (auth.uid()) is unchanged.
alter function public.edit_mara_calendar_approval(uuid, text, timestamptz)
  security definer;
alter function public.edit_mara_calendar_approval(uuid, text, timestamptz)
  set search_path = public, pg_temp;
revoke all on function public.edit_mara_calendar_approval(uuid, text, timestamptz) from public, anon;
grant execute on function public.edit_mara_calendar_approval(uuid, text, timestamptz) to authenticated;

-- 4. 0043's plan-protection trigger function is SECURITY DEFINER without a
--    pinned search_path.
alter function public.protect_business_plan()
  set search_path = public, pg_temp;

commit;
