-- Voom Phase 1 marketing plans. Prepared for review; do not apply without approval.
begin;

create table if not exists public.marketing_plans (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  business_id uuid not null references public.businesses (id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'superseded')),
  business_goal text not null check (char_length(business_goal) between 1 and 1000),
  weekly_strategy text not null check (char_length(weekly_strategy) between 1 and 5000),
  selected_channels text[] not null default '{}',
  content_frequency text not null check (char_length(content_frequency) between 1 and 200),
  planned_posts jsonb not null default '[]'::jsonb check (jsonb_typeof(planned_posts) = 'array'),
  planned_campaigns jsonb not null default '[]'::jsonb check (jsonb_typeof(planned_campaigns) = 'array'),
  recommendations jsonb not null default '[]'::jsonb check (jsonb_typeof(recommendations) = 'array'),
  source_summary jsonb not null default '{}'::jsonb check (jsonb_typeof(source_summary) = 'object'),
  valid_from date not null,
  valid_until date not null check (valid_until >= valid_from),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_user_id)
);

create index if not exists marketing_plans_owner_created_idx
  on public.marketing_plans (owner_user_id, created_at desc);
create unique index if not exists marketing_plans_one_active_owner_idx
  on public.marketing_plans (owner_user_id) where status = 'active';

drop trigger if exists set_marketing_plans_updated_at on public.marketing_plans;
create trigger set_marketing_plans_updated_at before update on public.marketing_plans
  for each row execute function public.set_updated_at();

alter table public.marketing_plans enable row level security;
revoke all on table public.marketing_plans from anon, authenticated;
grant select on table public.marketing_plans to authenticated;
grant select, insert, update on table public.marketing_plans to service_role;

drop policy if exists "marketing_plans_select_own" on public.marketing_plans;
create policy "marketing_plans_select_own" on public.marketing_plans
  for select to authenticated using ((select auth.uid()) = owner_user_id);

commit;
