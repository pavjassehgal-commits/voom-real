-- PROPOSED (unnumbered): Trend Intelligence — Stage 2A secure storage.
--
-- Lives outside supabase/migrations on purpose: the Supabase CLI never sees
-- it, and it cannot collide with the Admin Panel's unmerged local 0052–0054.
-- It receives the next free migration number only when the owner approves
-- integration (docs/trend-intelligence/STAGE-2A-STORAGE.md).
--
-- What it stores: validated, global (non-merchant) trend observations, their
-- metrics and their evidence, plus the owner-maintained source authorization
-- and coverage records that decide whether an observation may be stored.
--
-- Security model:
--   - backend only: RLS enabled with NO policies on every table; every
--     privilege revoked from public, anon and authenticated (including the
--     ones Supabase's default privileges grant to new objects);
--   - service_role gets the minimum: SELECT on reference/decision tables,
--     SELECT + INSERT on observations, metrics and evidence, EXECUTE on the
--     purge function. No UPDATE, DELETE or TRUNCATE anywhere;
--   - no owner_user_id, business id, email or any other merchant/customer
--     column; nothing references auth.users or businesses.
--
-- Integrity:
--   - observations are stored only for an APPROVED source with VERIFIED
--     coverage for the platform and country;
--   - item / topic / trend identity is computed by the database, never
--     supplied by the caller; (source, trend, window) is unique;
--   - observations, metrics and evidence are immutable; metrics and evidence
--     can only be added in the transaction that created their observation;
--   - every observation needs evidence and its source's required metrics at
--     commit (deferred check);
--   - unavailable metrics carry no value and no definition version;
--   - every row has a deletion deadline; YouTube rows at most 30 days after
--     retrieval; deletion cascades to metrics and evidence;
--   - trend_purge_expired() deletes overdue rows in bounded batches.
--     It is NOT scheduled: an execution mechanism must be approved before
--     any real ingestion is enabled.
--
-- Additive and idempotent. Rollback: trend_intelligence_storage.rollback.sql.

begin;

-- Once the governance file has extended this schema, re-running this file
-- would restore Stage 2A grants (direct INSERT for service_role) and guard
-- functions the governance RPCs depend on. Refuse instead of regressing.
-- (After trend_intelligence_governance.rollback.sql this file runs again.)
do $$
begin
  if to_regclass('public.trend_observation_invalidations') is not null then
    raise exception 'trend_storage_reapply_after_governance';
  end if;
end
$$;

-- ─── Reference data: the Stage 1 source registry, mirrored ───────────────
-- Kept identical to lib/trends/types.ts (a test fails on any drift).

create table if not exists public.trend_sources (
  source_id text primary key check (source_id ~ '^[a-z][a-z0-9_]{1,63}$'),
  platforms text[] not null check (cardinality(platforms) >= 1
    and platforms <@ array['google_search', 'youtube', 'instagram', 'tiktok', 'web']),
  subject_kinds text[] not null check (cardinality(subject_kinds) >= 1
    and subject_kinds <@ array['search_query', 'topic', 'hashtag', 'sound', 'video', 'format']),
  language_scope text not null check (language_scope in ('not_reported', 'optional')),
  requires_evidence_url boolean not null,
  -- Upper bound on how long any row from this source may be kept.
  max_retention_days integer not null check (max_retention_days between 1 and 365)
);

-- Upsert in one statement without INSERT ... ON CONFLICT: that form builds a
-- full new row before detecting the conflict, so it would fail NOT NULL
-- checks on columns a later migration adds (the governance part) when this
-- file is re-applied. Existing rows are updated; missing rows are inserted.
with registry (source_id, platforms, subject_kinds, language_scope, requires_evidence_url, max_retention_days) as (
  values
    ('google_trends_web', array['google_search'], array['search_query', 'topic'], 'not_reported', true, 365),
    ('google_trends_api', array['google_search'], array['search_query', 'topic'], 'not_reported', false, 365),
    -- YouTube API Services Developer Policies III.E.4: at most 30 calendar days.
    ('youtube_data_api', array['youtube'], array['video'], 'not_reported', false, 30),
    ('manual_research', array['google_search', 'youtube', 'instagram', 'tiktok', 'web'],
      array['search_query', 'topic', 'hashtag', 'sound', 'video', 'format'], 'optional', true, 365)
),
updated as (
  update public.trend_sources s set
    platforms = r.platforms,
    subject_kinds = r.subject_kinds,
    language_scope = r.language_scope,
    requires_evidence_url = r.requires_evidence_url,
    max_retention_days = r.max_retention_days
  from registry r
  where s.source_id = r.source_id
  returning s.source_id
)
insert into public.trend_sources
  (source_id, platforms, subject_kinds, language_scope, requires_evidence_url, max_retention_days)
select r.source_id, r.platforms, r.subject_kinds, r.language_scope, r.requires_evidence_url, r.max_retention_days
  from registry r
 where not exists (select 1 from public.trend_sources s where s.source_id = r.source_id);

create table if not exists public.trend_metric_definitions (
  version_id text primary key check (version_id ~ '^[a-z0-9_.]{3,120}$'),
  source_id text not null references public.trend_sources (source_id),
  metric_key text not null check (metric_key ~ '^[a-z][a-z0-9_]{0,63}$'),
  unit text not null check (unit in ('relative_index', 'scaled_interest', 'count', 'rank')),
  effective_from timestamptz,
  effective_until timestamptz,
  min_value numeric not null,
  max_value numeric,
  integer_only boolean not null,
  required boolean not null,
  check (effective_from is null or effective_until is null or effective_from < effective_until),
  check (max_value is null or min_value <= max_value)
);

insert into public.trend_metric_definitions
  (version_id, source_id, metric_key, unit, effective_from, effective_until, min_value, max_value, integer_only, required)
values
  ('google_trends_web.interest_index.v1', 'google_trends_web', 'interest_index', 'relative_index', null, null, 0, 100, true, true),
  ('google_trends_api.scaled_interest.alpha', 'google_trends_api', 'scaled_interest', 'scaled_interest', null, null, 0, null, false, true),
  ('youtube_data_api.chart_rank.v1', 'youtube_data_api', 'chart_rank', 'rank', null, null, 1, null, true, true),
  ('youtube_data_api.view_count.v1', 'youtube_data_api', 'view_count', 'count', null, '2026-08-24T00:00:00Z', 0, null, true, true),
  ('youtube_data_api.view_count.v2', 'youtube_data_api', 'view_count', 'count', '2026-08-24T00:00:00Z', null, 0, null, true, true),
  ('youtube_data_api.like_count.v1', 'youtube_data_api', 'like_count', 'count', null, null, 0, null, true, false),
  ('youtube_data_api.comment_count.v1', 'youtube_data_api', 'comment_count', 'count', null, null, 0, null, true, false)
on conflict (version_id) do update set
  source_id = excluded.source_id,
  metric_key = excluded.metric_key,
  unit = excluded.unit,
  effective_from = excluded.effective_from,
  effective_until = excluded.effective_until,
  min_value = excluded.min_value,
  max_value = excluded.max_value,
  integer_only = excluded.integer_only,
  required = excluded.required;

-- ─── Owner decisions: authorization and coverage ──────────────────────────
-- Maintained by the project owner (SQL editor / reviewed script). The app
-- can read them but never write them. No row = not reviewed = not allowed.

create table if not exists public.trend_source_authorizations (
  source_id text primary key references public.trend_sources (source_id),
  status text not null check (status in ('approved', 'not_approved', 'under_review')),
  decided_at timestamptz,
  decided_by text check (decided_by is null or char_length(btrim(decided_by)) between 1 and 200),
  reference text check (reference is null or char_length(btrim(reference)) between 1 and 1000),
  recorded_at timestamptz not null default now(),
  check (status = 'under_review' or (decided_at is not null and decided_by is not null)),
  check (status <> 'approved' or reference is not null)
);

create table if not exists public.trend_source_coverage (
  source_id text not null references public.trend_sources (source_id),
  platform text not null check (platform in ('google_search', 'youtube', 'instagram', 'tiktok', 'web')),
  country text not null check (country ~ '^[A-Z]{2}$'),
  status text not null check (status in ('verified', 'unavailable', 'unverified')),
  checked_at timestamptz,
  evidence text check (evidence is null or char_length(btrim(evidence)) between 1 and 1000),
  recorded_at timestamptz not null default now(),
  primary key (source_id, platform, country),
  check (status = 'unverified' or (checked_at is not null and evidence is not null))
);

-- ─── Observations ─────────────────────────────────────────────────────────

create table if not exists public.trend_observations (
  id uuid primary key default gen_random_uuid(),
  source_id text not null references public.trend_sources (source_id),
  platform text not null check (platform in ('google_search', 'youtube', 'instagram', 'tiktok', 'web')),
  country text not null check (country ~ '^[A-Z]{2}$'),
  language text not null check (language in
    ('und', 'en', 'ar', 'hi', 'zh-Hans', 'zh-Hant', 'tr', 'ms', 'id', 'th', 'vi', 'fil')),
  subject_kind text not null check (subject_kind in
    ('search_query', 'topic', 'hashtag', 'sound', 'video', 'format')),
  -- Untrusted provider text: stored inert, never interpreted.
  subject_text text not null check (char_length(subject_text) between 1 and 400),
  -- Stage 1 normalizeSubjectText() output (NFKC, invisible chars removed, lower case).
  subject_normalized text not null check (char_length(subject_normalized) between 1 and 200
    and subject_normalized = lower(subject_normalized)
    and subject_normalized = btrim(subject_normalized)),
  provider_item_id text check (provider_item_id is null or char_length(provider_item_id) between 1 and 128),

  window_start timestamptz not null,
  window_end timestamptz not null,
  retrieved_at timestamptz not null,
  fresh_until timestamptz not null,
  stale_after timestamptz not null,
  expires_at timestamptz not null,
  freshness_basis text not null check (freshness_basis in ('provisional_product_default', 'override')),
  delete_after timestamptz not null,
  stored_at timestamptz not null default now(),

  -- Identity, computed here so callers cannot forge it. Components before the
  -- free text come from fixed vocabularies without '|', so keys are unambiguous.
  item_key text generated always as (
    case when provider_item_id is null then null
      else 'item|' || platform || '|' || subject_kind || '|' || provider_item_id end
  ) stored,
  topic_key text generated always as (
    'topic|' || platform || '|' || country || '|' || language || '|' || subject_kind || '|' || subject_normalized
  ) stored,
  trend_key text generated always as (
    case when provider_item_id is null
      then 'topic|' || platform || '|' || country || '|' || language || '|' || subject_kind || '|' || subject_normalized
      else 'item|' || platform || '|' || country || '|' || language || '|' || subject_kind || '|' || provider_item_id end
  ) stored,

  constraint trend_observations_identity_key unique (source_id, trend_key, window_start, window_end),
  constraint trend_observations_window_order check (window_start <= window_end and window_end <= retrieved_at),
  constraint trend_observations_freshness_order check (
    window_end <= fresh_until and fresh_until <= stale_after and stale_after <= expires_at),
  constraint trend_observations_delete_after_retrieval check (delete_after > retrieved_at),
  -- Item identity rules (Stage 1 ITEM_IDENTITY_BY_KIND / PROVIDER_ITEM_ID_PATTERNS).
  constraint trend_observations_item_by_kind check (
    (subject_kind <> 'video' or provider_item_id is not null)
    and (subject_kind not in ('search_query', 'topic', 'hashtag', 'format') or provider_item_id is null)),
  constraint trend_observations_item_by_platform check (
    provider_item_id is null
    or (platform = 'youtube' and provider_item_id ~ '^[A-Za-z0-9_-]{11}$')
    or (platform = 'tiktok' and provider_item_id ~ '^[0-9]{1,32}$')
    or (platform = 'instagram' and provider_item_id ~ '^[A-Za-z0-9_-]{1,64}$'))
);

create index if not exists trend_observations_market_idx
  on public.trend_observations (platform, country, language, trend_key, window_end desc);
create index if not exists trend_observations_item_idx
  on public.trend_observations (item_key) where item_key is not null;
create index if not exists trend_observations_delete_after_idx
  on public.trend_observations (delete_after, id);

create table if not exists public.trend_observation_metrics (
  observation_id uuid not null references public.trend_observations (id) on delete cascade,
  metric_key text not null check (metric_key ~ '^[a-z][a-z0-9_]{0,63}$'),
  status text not null check (status in ('measured', 'unavailable')),
  value numeric,
  unit text not null check (unit in ('relative_index', 'scaled_interest', 'count', 'rank')),
  definition_version text,
  unavailable_reason text check (unavailable_reason is null or unavailable_reason in
    ('not_provided_by_source', 'hidden_by_owner', 'below_reporting_threshold', 'not_collected', 'collection_failed')),
  primary key (observation_id, metric_key),
  -- An unavailable metric can never become a number (in particular not 0).
  constraint trend_metrics_status_shape check (
    (status = 'measured' and value is not null and definition_version is not null and unavailable_reason is null)
    or (status = 'unavailable' and value is null and definition_version is null and unavailable_reason is not null)),
  constraint trend_metrics_value_finite check (
    value is null or value not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric))
);

create table if not exists public.trend_evidence (
  id uuid primary key default gen_random_uuid(),
  observation_id uuid not null references public.trend_observations (id) on delete cascade,
  source_id text not null references public.trend_sources (source_id),
  attribution text not null check (char_length(btrim(attribution)) between 1 and 200),
  -- Public https link without credentials; null where the source has none.
  url text check (url is null or (char_length(url) <= 2048 and url ~ '^https://[^/@[:space:]]+(/[^[:space:]]*)?$')),
  retrieved_at timestamptz not null
);

create index if not exists trend_evidence_observation_idx on public.trend_evidence (observation_id);

-- ─── Guards ───────────────────────────────────────────────────────────────

create or replace function public.trend_guard_observation_insert()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_source public.trend_sources%rowtype;
begin
  select * into v_source from public.trend_sources where source_id = new.source_id;
  if not found then
    raise exception 'trend_unknown_source';
  end if;
  if not (new.platform = any (v_source.platforms)) then
    raise exception 'trend_platform_not_supported_by_source';
  end if;
  if not (new.subject_kind = any (v_source.subject_kinds)) then
    raise exception 'trend_subject_kind_not_supported_by_source';
  end if;
  if v_source.language_scope = 'not_reported' and new.language <> 'und' then
    raise exception 'trend_language_must_be_undetermined';
  end if;
  if not exists (
    select 1 from public.trend_source_authorizations a
     where a.source_id = new.source_id and a.status = 'approved'
  ) then
    raise exception 'trend_source_not_authorized';
  end if;
  if not exists (
    select 1 from public.trend_source_coverage c
     where c.source_id = new.source_id and c.platform = new.platform
       and c.country = new.country and c.status = 'verified'
  ) then
    raise exception 'trend_coverage_not_verified';
  end if;
  if new.retrieved_at > now() + interval '5 minutes' then
    raise exception 'trend_retrieved_in_future';
  end if;
  if new.delete_after > new.retrieved_at + make_interval(days => v_source.max_retention_days) then
    raise exception 'trend_retention_exceeds_source_limit';
  end if;
  if new.delete_after <= now() then
    raise exception 'trend_retention_deadline_passed';
  end if;
  new.stored_at := now();
  return new;
end;
$$;

-- Rows are immutable: no UPDATE, even for privileged roles.
create or replace function public.trend_guard_immutable()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'trend_rows_are_immutable';
end;
$$;

-- Metrics: known metric for the source; measured values carry a definition
-- version in force at retrieval, the definition's unit and its bounds.
create or replace function public.trend_guard_metric_insert()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_obs record;
  v_def public.trend_metric_definitions%rowtype;
  v_unit text;
begin
  select o.source_id, o.retrieved_at, (o.xmin = pg_current_xact_id()::xid) as same_tx
    into v_obs from public.trend_observations o where o.id = new.observation_id;
  if not found then
    raise exception 'trend_unknown_observation';
  end if;
  if not v_obs.same_tx then
    raise exception 'trend_observation_is_sealed';
  end if;

  select d.unit into v_unit from public.trend_metric_definitions d
   where d.source_id = v_obs.source_id and d.metric_key = new.metric_key limit 1;
  if v_unit is null then
    raise exception 'trend_unknown_metric';
  end if;
  if new.unit <> v_unit then
    raise exception 'trend_metric_unit_mismatch';
  end if;
  if new.status = 'unavailable' then
    return new;
  end if;

  select * into v_def from public.trend_metric_definitions d
   where d.version_id = new.definition_version
     and d.source_id = v_obs.source_id and d.metric_key = new.metric_key;
  if not found then
    raise exception 'trend_unknown_metric_definition';
  end if;
  if (v_def.effective_from is not null and v_obs.retrieved_at < v_def.effective_from)
     or (v_def.effective_until is not null and v_obs.retrieved_at >= v_def.effective_until) then
    raise exception 'trend_metric_definition_not_in_effect';
  end if;
  if new.value < v_def.min_value or (v_def.max_value is not null and new.value > v_def.max_value) then
    raise exception 'trend_metric_out_of_range';
  end if;
  if v_def.integer_only and new.value <> trunc(new.value) then
    raise exception 'trend_metric_not_integer';
  end if;
  return new;
end;
$$;

create or replace function public.trend_guard_evidence_insert()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_obs record;
  v_requires_url boolean;
begin
  select o.source_id, (o.xmin = pg_current_xact_id()::xid) as same_tx
    into v_obs from public.trend_observations o where o.id = new.observation_id;
  if not found then
    raise exception 'trend_unknown_observation';
  end if;
  if not v_obs.same_tx then
    raise exception 'trend_observation_is_sealed';
  end if;
  if new.source_id <> v_obs.source_id then
    raise exception 'trend_evidence_source_mismatch';
  end if;
  select s.requires_evidence_url into v_requires_url from public.trend_sources s where s.source_id = new.source_id;
  if v_requires_url and new.url is null then
    raise exception 'trend_evidence_url_required';
  end if;
  if new.retrieved_at > now() + interval '5 minutes' then
    raise exception 'trend_retrieved_in_future';
  end if;
  return new;
end;
$$;

-- At commit: every observation has evidence and its source's required metrics.
create or replace function public.trend_check_observation_complete()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if not exists (select 1 from public.trend_observations o where o.id = new.id) then
    return null; -- deleted in the same transaction
  end if;
  if not exists (select 1 from public.trend_evidence e where e.observation_id = new.id) then
    raise exception 'trend_observation_missing_evidence';
  end if;
  if exists (
    select 1 from public.trend_metric_definitions d
     where d.source_id = new.source_id and d.required
       and not exists (
         select 1 from public.trend_observation_metrics m
          where m.observation_id = new.id and m.metric_key = d.metric_key)
  ) then
    raise exception 'trend_observation_missing_required_metric';
  end if;
  return null;
end;
$$;

drop trigger if exists trend_observations_guard_insert on public.trend_observations;
create trigger trend_observations_guard_insert
  before insert on public.trend_observations
  for each row execute function public.trend_guard_observation_insert();

drop trigger if exists trend_observations_complete on public.trend_observations;
create constraint trigger trend_observations_complete
  after insert on public.trend_observations
  deferrable initially deferred
  for each row execute function public.trend_check_observation_complete();

drop trigger if exists trend_metrics_guard_insert on public.trend_observation_metrics;
create trigger trend_metrics_guard_insert
  before insert on public.trend_observation_metrics
  for each row execute function public.trend_guard_metric_insert();

drop trigger if exists trend_evidence_guard_insert on public.trend_evidence;
create trigger trend_evidence_guard_insert
  before insert on public.trend_evidence
  for each row execute function public.trend_guard_evidence_insert();

drop trigger if exists trend_observations_immutable on public.trend_observations;
create trigger trend_observations_immutable
  before update on public.trend_observations
  for each row execute function public.trend_guard_immutable();

drop trigger if exists trend_metrics_immutable on public.trend_observation_metrics;
create trigger trend_metrics_immutable
  before update on public.trend_observation_metrics
  for each row execute function public.trend_guard_immutable();

drop trigger if exists trend_evidence_immutable on public.trend_evidence;
create trigger trend_evidence_immutable
  before update on public.trend_evidence
  for each row execute function public.trend_guard_immutable();

-- ─── Bounded purge (NOT scheduled) ────────────────────────────────────────
-- Deletes up to p_limit observations whose deletion deadline has passed,
-- oldest deadline first; metrics and evidence go with them (cascade).
-- Uses the database clock only, so a caller cannot purge early.

create or replace function public.trend_purge_expired(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_deleted integer;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'trend_invalid_purge_limit';
  end if;
  with doomed as (
    select o.id from public.trend_observations o
     where o.delete_after <= now()
     order by o.delete_after, o.id
     limit p_limit
     for update skip locked
  )
  delete from public.trend_observations o using doomed where o.id = doomed.id;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- ─── Privileges ───────────────────────────────────────────────────────────

alter table public.trend_sources enable row level security;
alter table public.trend_metric_definitions enable row level security;
alter table public.trend_source_authorizations enable row level security;
alter table public.trend_source_coverage enable row level security;
alter table public.trend_observations enable row level security;
alter table public.trend_observation_metrics enable row level security;
alter table public.trend_evidence enable row level security;

revoke all on table
  public.trend_sources, public.trend_metric_definitions,
  public.trend_source_authorizations, public.trend_source_coverage,
  public.trend_observations, public.trend_observation_metrics, public.trend_evidence
  from public, anon, authenticated, service_role;

grant select on table
  public.trend_sources, public.trend_metric_definitions,
  public.trend_source_authorizations, public.trend_source_coverage
  to service_role;
grant select, insert on table
  public.trend_observations, public.trend_observation_metrics, public.trend_evidence
  to service_role;

revoke all on function public.trend_guard_observation_insert() from public, anon, authenticated, service_role;
revoke all on function public.trend_guard_immutable() from public, anon, authenticated, service_role;
revoke all on function public.trend_guard_metric_insert() from public, anon, authenticated, service_role;
revoke all on function public.trend_guard_evidence_insert() from public, anon, authenticated, service_role;
revoke all on function public.trend_check_observation_complete() from public, anon, authenticated, service_role;
revoke all on function public.trend_purge_expired(integer) from public, anon, authenticated, service_role;
grant execute on function public.trend_purge_expired(integer) to service_role;

commit;
