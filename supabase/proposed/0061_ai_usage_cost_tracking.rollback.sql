-- Rollback for 0061_ai_usage_cost_tracking.sql.
--
-- This is intentionally not a numbered migration. It must only be run after
-- separate approval. The rollback refuses to remove the 0061 schema if any AI
-- usage, provider-attempt, or reconciliation rows exist, because those rows may
-- be real accounting records. It uses no CASCADE, so unrelated dependencies
-- also cause PostgreSQL to stop instead of deleting them.

begin;

do $$
begin
  if to_regclass('public.ai_usage_operations') is null
     or to_regclass('public.ai_provider_attempts') is null
     or to_regclass('public.credit_reconciliation_tasks') is null
     or to_regprocedure('public.record_ai_usage_attempt(uuid,uuid,text,text,text,text,text,integer,text,text,integer,bigint,bigint,bigint,bigint,integer,numeric,numeric,numeric,numeric,text,text)') is null then
    raise exception '0061 rollback refused: expected 0061 objects are incomplete';
  end if;

  if exists (select 1 from public.ai_usage_operations)
     or exists (select 1 from public.ai_provider_attempts)
     or exists (select 1 from public.credit_reconciliation_tasks) then
    raise exception '0061 rollback refused: AI usage or reconciliation records exist';
  end if;
end
$$;

drop function public.record_ai_usage_attempt(
  uuid,uuid,text,text,text,text,text,integer,text,text,integer,
  bigint,bigint,bigint,bigint,integer,numeric,numeric,numeric,numeric,text,text
);
drop table public.ai_provider_attempts;
drop table public.credit_reconciliation_tasks;
drop table public.ai_usage_operations;

do $$
begin
  if to_regclass('public.ai_usage_operations') is not null
     or to_regclass('public.ai_provider_attempts') is not null
     or to_regclass('public.credit_reconciliation_tasks') is not null
     or to_regprocedure('public.record_ai_usage_attempt(uuid,uuid,text,text,text,text,text,integer,text,text,integer,bigint,bigint,bigint,bigint,integer,numeric,numeric,numeric,numeric,text,text)') is not null then
    raise exception '0061 rollback incomplete';
  end if;
end
$$;

commit;
