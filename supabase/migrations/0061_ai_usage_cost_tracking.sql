-- 0061_ai_usage_cost_tracking.sql
-- Provider-independent AI usage, cost attempts, and credit reconciliation.
-- Additive only. Text usage is observed but never deducts Voom credits.

begin;

create table if not exists public.ai_usage_operations (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid references public.businesses(id) on delete set null,
  operation_key text not null check (char_length(operation_key) between 1 and 160),
  operation_type text not null check (char_length(operation_type) between 1 and 80),
  category text not null check (category in ('text','caption','recommendation','planning','image','video')),
  provider text not null check (char_length(provider) between 1 and 80),
  model text not null check (char_length(model) between 1 and 160),
  status text not null default 'started' check (status in ('started','succeeded','failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  input_tokens bigint check (input_tokens is null or input_tokens >= 0),
  output_tokens bigint check (output_tokens is null or output_tokens >= 0),
  reasoning_tokens bigint check (reasoning_tokens is null or reasoning_tokens >= 0),
  total_tokens bigint check (total_tokens is null or total_tokens >= 0),
  media_units integer check (media_units is null or media_units >= 0),
  estimated_cost_usd numeric(14,8) check (estimated_cost_usd is null or estimated_cost_usd >= 0),
  observed_cost_usd numeric(14,8) check (observed_cost_usd is null or observed_cost_usd >= 0),
  confirmed_provider_charge_usd numeric(14,8) check (confirmed_provider_charge_usd is null or confirmed_provider_charge_usd >= 0),
  pricing_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_user_id, operation_key)
);

create table if not exists public.ai_provider_attempts (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references public.ai_usage_operations(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid references public.businesses(id) on delete set null,
  attempt_number integer not null check (attempt_number > 0),
  provider_request_id text,
  provider text not null,
  model text not null,
  status text not null check (status in ('succeeded','failed','unknown')),
  http_status integer check (http_status is null or http_status between 100 and 599),
  input_tokens bigint check (input_tokens is null or input_tokens >= 0),
  output_tokens bigint check (output_tokens is null or output_tokens >= 0),
  reasoning_tokens bigint check (reasoning_tokens is null or reasoning_tokens >= 0),
  total_tokens bigint check (total_tokens is null or total_tokens >= 0),
  media_units integer check (media_units is null or media_units >= 0),
  duration_seconds numeric(10,3) check (duration_seconds is null or duration_seconds >= 0),
  estimated_cost_usd numeric(14,8) check (estimated_cost_usd is null or estimated_cost_usd >= 0),
  observed_cost_usd numeric(14,8) check (observed_cost_usd is null or observed_cost_usd >= 0),
  confirmed_provider_charge_usd numeric(14,8) check (confirmed_provider_charge_usd is null or confirmed_provider_charge_usd >= 0),
  pricing_version text,
  error_code text,
  created_at timestamptz not null default now(),
  unique (operation_id, attempt_number)
);

create table if not exists public.credit_reconciliation_tasks (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  generation_id text not null,
  action text not null check (action in ('settle','refund')),
  status text not null default 'pending' check (status in ('pending','processing','resolved')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_error_code text,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (owner_user_id, generation_id, action)
);

create index if not exists ai_usage_operations_owner_created_idx on public.ai_usage_operations(owner_user_id, created_at desc);
create index if not exists ai_provider_attempts_owner_created_idx on public.ai_provider_attempts(owner_user_id, created_at desc);
create index if not exists credit_reconciliation_pending_idx on public.credit_reconciliation_tasks(next_attempt_at) where status = 'pending';

alter table public.ai_usage_operations enable row level security;
alter table public.ai_provider_attempts enable row level security;
alter table public.credit_reconciliation_tasks enable row level security;

create policy "owners read own ai usage operations" on public.ai_usage_operations for select using (auth.uid() = owner_user_id);
create policy "owners read own ai provider attempts" on public.ai_provider_attempts for select using (auth.uid() = owner_user_id);
create policy "owners read own credit reconciliation" on public.credit_reconciliation_tasks for select using (auth.uid() = owner_user_id);

revoke all on public.ai_usage_operations, public.ai_provider_attempts, public.credit_reconciliation_tasks from public, anon, authenticated;
grant select on public.ai_usage_operations, public.ai_provider_attempts, public.credit_reconciliation_tasks to authenticated;
grant all on public.ai_usage_operations, public.ai_provider_attempts, public.credit_reconciliation_tasks to service_role;

create or replace function public.record_ai_usage_attempt(
  p_owner_user_id uuid, p_business_id uuid, p_operation_key text, p_operation_type text,
  p_category text, p_provider text, p_model text, p_attempt_number integer,
  p_status text, p_provider_request_id text, p_http_status integer,
  p_input_tokens bigint, p_output_tokens bigint, p_reasoning_tokens bigint, p_total_tokens bigint,
  p_media_units integer, p_duration_seconds numeric, p_estimated_cost_usd numeric,
  p_observed_cost_usd numeric, p_confirmed_provider_charge_usd numeric,
  p_pricing_version text, p_error_code text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_operation_id uuid;
begin
  if p_owner_user_id is null or p_attempt_number < 1 then raise exception 'invalid_ai_usage_attempt'; end if;
  if p_business_id is not null and not exists (
    select 1 from public.businesses where id = p_business_id and owner_user_id = p_owner_user_id
  ) then raise exception 'business_owner_mismatch'; end if;

  insert into public.ai_usage_operations (
    owner_user_id,business_id,operation_key,operation_type,category,provider,model,status,pricing_version
  ) values (
    p_owner_user_id,p_business_id,p_operation_key,p_operation_type,p_category,p_provider,p_model,
    case when p_status = 'succeeded' then 'succeeded' else 'failed' end,p_pricing_version
  ) on conflict (owner_user_id, operation_key) do update set
    business_id = coalesce(ai_usage_operations.business_id, excluded.business_id),
    status = case when excluded.status = 'succeeded' then 'succeeded' else ai_usage_operations.status end,
    updated_at = now()
  returning id into v_operation_id;

  insert into public.ai_provider_attempts (
    operation_id,owner_user_id,business_id,attempt_number,provider_request_id,provider,model,status,http_status,
    input_tokens,output_tokens,reasoning_tokens,total_tokens,media_units,duration_seconds,
    estimated_cost_usd,observed_cost_usd,confirmed_provider_charge_usd,pricing_version,error_code
  ) values (
    v_operation_id,p_owner_user_id,p_business_id,p_attempt_number,p_provider_request_id,p_provider,p_model,p_status,p_http_status,
    p_input_tokens,p_output_tokens,p_reasoning_tokens,p_total_tokens,p_media_units,p_duration_seconds,
    p_estimated_cost_usd,p_observed_cost_usd,p_confirmed_provider_charge_usd,p_pricing_version,p_error_code
  ) on conflict (operation_id, attempt_number) do nothing;

  update public.ai_usage_operations o set
    attempt_count = a.attempt_count,
    input_tokens = a.input_tokens,
    output_tokens = a.output_tokens,
    reasoning_tokens = a.reasoning_tokens,
    total_tokens = a.total_tokens,
    media_units = a.media_units,
    estimated_cost_usd = a.estimated_cost_usd,
    observed_cost_usd = a.observed_cost_usd,
    confirmed_provider_charge_usd = a.confirmed_provider_charge_usd,
    updated_at = now()
  from (
    select count(*)::int attempt_count, sum(input_tokens) input_tokens, sum(output_tokens) output_tokens,
      sum(reasoning_tokens) reasoning_tokens, sum(total_tokens) total_tokens, sum(media_units)::int media_units,
      sum(estimated_cost_usd) estimated_cost_usd, sum(observed_cost_usd) observed_cost_usd,
      sum(confirmed_provider_charge_usd) confirmed_provider_charge_usd
    from public.ai_provider_attempts where operation_id = v_operation_id
  ) a where o.id = v_operation_id;
  return v_operation_id;
end;
$$;

revoke all on function public.record_ai_usage_attempt(uuid,uuid,text,text,text,text,text,integer,text,text,integer,bigint,bigint,bigint,bigint,integer,numeric,numeric,numeric,numeric,text,text) from public, anon, authenticated;
grant execute on function public.record_ai_usage_attempt(uuid,uuid,text,text,text,text,text,integer,text,text,integer,bigint,bigint,bigint,bigint,integer,numeric,numeric,numeric,numeric,text,text) to service_role;

commit;
