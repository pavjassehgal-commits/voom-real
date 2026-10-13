-- 0056_trend_mara_workflow_context.sql — PROPOSED, NOT APPLIED.
-- Owner-scoped, reviewed output of the deterministic Trend Intelligence
-- recommendation pipeline. The MARA request path may read these rows only
-- when VOOM_TREND_CONTEXT_ENABLED=true and revalidates every linked
-- observation through trend_list_usable_observations before using it.
-- No worker, schedule, provider, credential, webhook or network operation.

begin;

do $$
begin
  if to_regclass('public.trend_observations') is null then
    raise exception '0056 requires approved migration 0055_trend_intelligence';
  end if;
end
$$;

create table if not exists public.trend_mara_contexts (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  trend_key text not null check (length(trend_key) between 1 and 500),
  platform text not null check (platform in ('google_search','youtube','instagram','tiktok','web')),
  market_country text not null check (market_country ~ '^[A-Z]{2}$'),
  market_language text not null check (length(market_language) between 2 and 16),
  topic text not null check (length(topic) between 1 and 200),
  event_start date,
  event_end date,
  facts jsonb not null check (jsonb_typeof(facts) = 'array' and jsonb_array_length(facts) between 1 and 6),
  observed_at timestamptz not null,
  confidence text not null check (confidence in ('low','medium','high')),
  caveats jsonb not null default '[]'::jsonb check (jsonb_typeof(caveats) = 'array' and jsonb_array_length(caveats) <= 4),
  observation_ids uuid[] not null check (cardinality(observation_ids) between 1 and 20),
  status text not null default 'pending_review' check (status in ('pending_review','approved','rejected','revoked')),
  reviewed_by text,
  reviewed_at timestamptz,
  valid_until timestamptz not null,
  created_at timestamptz not null default now(),
  check ((event_start is null) = (event_end is null)),
  check (event_start is null or event_start <= event_end),
  check (status <> 'approved' or (reviewed_by is not null and reviewed_at is not null)),
  check (valid_until > observed_at)
);

create index if not exists trend_mara_contexts_owner_current_idx
  on public.trend_mara_contexts (owner_user_id, valid_until)
  where status = 'approved';

alter table public.trend_mara_contexts enable row level security;
-- Supabase default privileges may have granted every API role, including the
-- BYPASSRLS service role, broad table rights at CREATE TABLE time. Revoke all
-- of them explicitly before adding back the one application capability this
-- table needs. Reviewed contexts therefore remain database-owner writes only.
revoke all on table public.trend_mara_contexts from anon, authenticated, public, service_role;
grant select on table public.trend_mara_contexts to service_role;

comment on table public.trend_mara_contexts is
  'Reviewed, owner-scoped Trend Intelligence output for flag-gated MARA planning; service role read only.';

commit;
