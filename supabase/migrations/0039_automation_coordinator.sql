-- 0039_automation_coordinator.sql
-- Automation Intelligence / Coordinator v1
--
-- Adds:
-- 1. voom_coordinator_runs: durable ledger of coordinator evaluations and proposed needs
-- 2. Owner-scoped RLS and composite keys
-- 3. Idempotency guarantees for automated decisions and actions

begin;

create table if not exists public.voom_coordinator_runs (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  business_id uuid not null references public.businesses (id) on delete cascade,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 255),
  trigger text not null default 'scheduled' check (trigger in ('scheduled', 'replenish', 'manual', 'ui_read')),
  automation_mode text not null check (automation_mode in ('manual', 'assisted', 'autopilot')),
  horizon_start text not null,
  horizon_end text not null,
  needs jsonb not null default '[]'::jsonb,
  actions_taken jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (id, owner_user_id),
  unique (owner_user_id, idempotency_key)
);

create index if not exists coordinator_runs_owner_created_idx
  on public.voom_coordinator_runs (owner_user_id, created_at desc);

create index if not exists coordinator_runs_owner_idemp_idx
  on public.voom_coordinator_runs (owner_user_id, idempotency_key);

alter table public.voom_coordinator_runs enable row level security;

revoke all on table public.voom_coordinator_runs from anon, authenticated;
grant select on table public.voom_coordinator_runs to authenticated;

drop policy if exists coordinator_runs_owner_select on public.voom_coordinator_runs;
create policy coordinator_runs_owner_select on public.voom_coordinator_runs
  for select to authenticated
  using (owner_user_id = auth.uid());

grant select, insert, update, delete on table public.voom_coordinator_runs to service_role;

commit;
