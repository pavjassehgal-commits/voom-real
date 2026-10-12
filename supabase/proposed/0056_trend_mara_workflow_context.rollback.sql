-- 0056_trend_mara_workflow_context.rollback.sql — PROPOSED, NOT APPLIED.
--
-- Roll back 0056 before rolling back 0055. This removes only the owner-scoped
-- MARA context table and its dependent index. Any staging test contexts stored
-- in that table are permanently deleted. It does not touch 0055 trend evidence,
-- Admin Panel objects, auth users, businesses, or other customer data.
--
-- Deliberately no CASCADE: if a later object depends on the table, PostgreSQL
-- refuses the rollback instead of deleting an unreviewed dependency.

begin;

drop table if exists public.trend_mara_contexts;

do $$
begin
  if to_regclass('public.trend_mara_contexts') is not null
     or to_regclass('public.trend_mara_contexts_owner_current_idx') is not null then
    raise exception '0056_rollback_incomplete';
  end if;
end
$$;

commit;
