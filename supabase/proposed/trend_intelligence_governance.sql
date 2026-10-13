-- PROPOSED (unnumbered): Trend Intelligence — Stage 2C RPC and data governance.
--
-- Applies AFTER supabase/proposed/trend_intelligence_storage.sql. Like that
-- file it lives outside supabase/migrations: nothing deploys or schedules it.
-- At integration the two files become consecutive numbered migrations (or
-- one), in this order.
--
-- Adds:
--   1. trend_store_observation(jsonb, uuid): the ONLY write path for
--      observations. Service role only, SECURITY DEFINER, fixed search_path,
--      no dynamic SQL. Validates the payload, current authorization and
--      coverage (locked against concurrent revocation), computes freshness and
--      the deletion deadline itself, and stores observation + metrics +
--      evidence atomically. Returns a sanitized jsonb result.
--   2. Corrections: append-only trend_observation_invalidations,
--      trend_invalidate_observation(), and revisioned replacements
--      (revision n+1 only after revision n is invalidated).
--   3. Append-only trend_audit_events for authorization, coverage and
--      invalidation changes, written by triggers. Holds no provider content.
--      Retained 730 days.
--   4. Retention: trend_run_retention_purge() (bounded, records every run,
--      reports failures) and trend_retention_status(). NOT scheduled.
--
-- Additive and idempotent. Rollback: trend_intelligence_governance.rollback.sql.

begin;

-- ─── 0. Governance settings (provisional product defaults) ────────────────
-- One definition each, used by every function below and mirrored by
-- TREND_GOVERNANCE_SETTINGS in lib/trends/types.ts (a test fails on drift).
-- Product defaults, not legal conclusions.

create or replace function public.trend_authorization_review_period()
returns interval language sql immutable set search_path = pg_catalog, pg_temp
as $$ select interval '365 days' $$;

create or replace function public.trend_coverage_review_period()
returns interval language sql immutable set search_path = pg_catalog, pg_temp
as $$ select interval '180 days' $$;

create or replace function public.trend_audit_retention_period()
returns interval language sql immutable set search_path = pg_catalog, pg_temp
as $$ select interval '730 days' $$;

create or replace function public.trend_purge_run_retention_period()
returns interval language sql immutable set search_path = pg_catalog, pg_temp
as $$ select interval '90 days' $$;

-- ─── 1. Source freshness lives in the database too ────────────────────────
-- The RPC computes freshness and deletion deadlines; callers cannot choose
-- them. Mirrors TREND_SOURCES[*].freshness (a test fails on drift).

alter table public.trend_sources add column if not exists fresh_for interval;
alter table public.trend_sources add column if not exists stale_after interval;
alter table public.trend_sources add column if not exists expires_after interval;

update public.trend_sources set
  fresh_for = case source_id
    when 'youtube_data_api' then interval '1 day'
    when 'manual_research' then interval '7 days'
    else interval '3 days' end,
  stale_after = case source_id
    when 'youtube_data_api' then interval '3 days'
    when 'manual_research' then interval '14 days'
    else interval '7 days' end,
  expires_after = case source_id
    when 'youtube_data_api' then interval '7 days'
    else interval '30 days' end;

alter table public.trend_sources alter column fresh_for set not null;
alter table public.trend_sources alter column stale_after set not null;
alter table public.trend_sources alter column expires_after set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'trend_sources_freshness_order') then
    alter table public.trend_sources add constraint trend_sources_freshness_order
      check (fresh_for > interval '0' and fresh_for <= stale_after and stale_after <= expires_after);
  end if;
  -- Every decision (approval or refusal) names its record.
  if not exists (select 1 from pg_constraint where conname = 'trend_source_authorizations_decision_reference') then
    alter table public.trend_source_authorizations add constraint trend_source_authorizations_decision_reference
      check (status = 'under_review' or reference is not null);
  end if;
end
$$;

-- Who checked coverage (the responsible actor in the audit trail).
alter table public.trend_source_coverage add column if not exists checked_by text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'trend_source_coverage_checked_by') then
    alter table public.trend_source_coverage add constraint trend_source_coverage_checked_by
      check ((status = 'unverified' or checked_by is not null)
        and (checked_by is null or char_length(btrim(checked_by)) between 1 and 200));
  end if;
end
$$;

-- ─── 2. Revisions and invalidations ───────────────────────────────────────

alter table public.trend_observations add column if not exists revision smallint not null default 1;
alter table public.trend_observations add column if not exists replaces_observation_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'trend_observations_revision_shape') then
    alter table public.trend_observations add constraint trend_observations_revision_shape
      check (revision between 1 and 20 and ((revision = 1) = (replaces_observation_id is null)));
  end if;
  -- Identity now includes the revision (same constraint name, so callers
  -- keep using `on conflict on constraint trend_observations_identity_key`).
  if (select array_length(conkey, 1) from pg_constraint where conname = 'trend_observations_identity_key') = 4 then
    alter table public.trend_observations drop constraint trend_observations_identity_key;
    alter table public.trend_observations add constraint trend_observations_identity_key
      unique (source_id, trend_key, window_start, window_end, revision);
  end if;
end
$$;

create table if not exists public.trend_observation_invalidations (
  -- Cascades with its observation, so it never outlives the source's retention.
  observation_id uuid primary key references public.trend_observations (id) on delete cascade,
  reason_code text not null check (reason_code in
    ('wrong_evidence', 'wrong_item', 'wrong_market', 'wrong_metric', 'source_withdrawn', 'other_verified_error')),
  invalidated_at timestamptz not null default now(),
  -- An opaque actor id (e.g. "admin:<uuid>"), never free text or an email.
  actor text not null check (actor ~ '^[A-Za-z0-9._:-]{1,120}$'),
  -- A ticket/record id. No spaces or slashes: it cannot carry titles or URLs.
  reference text not null check (reference ~ '^[A-Za-z0-9._:#-]{1,120}$')
);

-- ─── 3. Audit trail ───────────────────────────────────────────────────────

create table if not exists public.trend_audit_events (
  id uuid primary key default gen_random_uuid(),
  -- Unambiguous order, even for events with the same timestamp.
  seq bigint generated always as identity,
  occurred_at timestamptz not null default now(),
  event_type text not null check (event_type in (
    'authorization_recorded', 'authorization_changed', 'authorization_removed',
    'coverage_recorded', 'coverage_changed', 'coverage_removed',
    'observation_invalidated')),
  db_role text not null,
  actor text not null check (char_length(btrim(actor)) between 1 and 200),
  source_id text not null,
  platform text,
  country text,
  -- A Voom row id only (no FK): survives the observation's purge, carries no content.
  observation_id uuid,
  -- Fixed decision fields only (status, times, decider, reference/evidence, reason).
  previous jsonb,
  next jsonb,
  reference text check (reference is null or char_length(reference) <= 1000)
);

create index if not exists trend_audit_events_occurred_idx on public.trend_audit_events (occurred_at, seq);
create index if not exists trend_audit_events_source_idx on public.trend_audit_events (source_id, occurred_at desc);

create table if not exists public.trend_purge_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null,
  finished_at timestamptz not null,
  status text not null check (status in ('succeeded', 'failed')),
  batch_limit integer not null,
  observations_deleted integer not null default 0,
  audit_events_deleted integer not null default 0,
  purge_runs_deleted integer not null default 0,
  remaining_overdue integer not null,
  oldest_overdue_at timestamptz,
  error_code text check (error_code is null or error_code ~ '^[a-z0-9_]{1,80}$'),
  check ((status = 'failed') = (error_code is not null))
);

create index if not exists trend_purge_runs_finished_idx on public.trend_purge_runs (finished_at desc);

-- ─── Guards ───────────────────────────────────────────────────────────────

-- Revisions: n > 1 only directly after an invalidated revision n - 1 of the
-- same identity, and it must name that observation. (Generated columns are
-- not computed yet in BEFORE triggers, so the trend key is derived here from
-- the same base columns and formula.)
create or replace function public.trend_guard_observation_revision()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.revision > 1 and not exists (
    select 1
      from public.trend_observations p
      join public.trend_observation_invalidations i on i.observation_id = p.id
     where p.id = new.replaces_observation_id
       and p.source_id = new.source_id
       and p.trend_key = case when new.provider_item_id is null
             then 'topic|' || new.platform || '|' || new.country || '|' || new.language || '|' || new.subject_kind || '|' || new.subject_normalized
             else 'item|' || new.platform || '|' || new.country || '|' || new.language || '|' || new.subject_kind || '|' || new.provider_item_id end
       and p.window_start = new.window_start
       and p.window_end = new.window_end
       and p.revision = new.revision - 1
  ) then
    raise exception 'trend_invalid_replacement';
  end if;
  return new;
end;
$$;

-- Deletion only through the purge functions (which set trend.purge locally).
create or replace function public.trend_guard_purge_only()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if coalesce(current_setting('trend.purge', true), '') <> 'on' then
    raise exception 'trend_delete_only_by_purge';
  end if;
  return old;
end;
$$;

-- Records every authorization / coverage change. Runs as the function owner
-- so the audit row is written whoever made the change.
create or replace function public.trend_audit_policy_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_prev jsonb;
  v_next jsonb;
  v_row record;
  v_actor text;
  v_type text;
  v_ref text;
begin
  if tg_table_name = 'trend_source_authorizations' then
    if tg_op <> 'INSERT' then
      v_prev := jsonb_build_object('status', old.status, 'decided_at', old.decided_at, 'decided_by', old.decided_by, 'reference', old.reference);
    end if;
    if tg_op <> 'DELETE' then
      v_next := jsonb_build_object('status', new.status, 'decided_at', new.decided_at, 'decided_by', new.decided_by, 'reference', new.reference);
      v_actor := coalesce(new.decided_by, current_user);
      v_ref := new.reference;
    end if;
    v_type := case tg_op when 'INSERT' then 'authorization_recorded' when 'UPDATE' then 'authorization_changed' else 'authorization_removed' end;
  else
    if tg_op <> 'INSERT' then
      v_prev := jsonb_build_object('status', old.status, 'checked_at', old.checked_at, 'checked_by', old.checked_by, 'evidence', old.evidence);
    end if;
    if tg_op <> 'DELETE' then
      v_next := jsonb_build_object('status', new.status, 'checked_at', new.checked_at, 'checked_by', new.checked_by, 'evidence', new.evidence);
      v_actor := coalesce(new.checked_by, current_user);
      v_ref := new.evidence;
    end if;
    v_type := case tg_op when 'INSERT' then 'coverage_recorded' when 'UPDATE' then 'coverage_changed' else 'coverage_removed' end;
  end if;
  if tg_op = 'DELETE' then v_row := old; else v_row := new; end if;
  if tg_op = 'UPDATE' and v_prev = v_next then
    return null; -- nothing material changed
  end if;
  insert into public.trend_audit_events
    (event_type, db_role, actor, source_id, platform, country, previous, next, reference)
  values (
    v_type, current_user, coalesce(v_actor, current_user), v_row.source_id,
    to_jsonb(v_row) ->> 'platform',
    to_jsonb(v_row) ->> 'country',
    v_prev, v_next, v_ref);
  return null;
end;
$$;

-- A changed decision must carry its own new decision time.
create or replace function public.trend_guard_decision_update()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_table_name = 'trend_source_authorizations' then
    if (new.status, new.decided_by, new.reference) is distinct from (old.status, old.decided_by, old.reference)
       and new.status <> 'under_review' and new.decided_at is not distinct from old.decided_at then
      raise exception 'trend_decision_needs_new_timestamp';
    end if;
  else
    if (new.status, new.checked_by, new.evidence) is distinct from (old.status, old.checked_by, old.evidence)
       and new.status <> 'unverified' and new.checked_at is not distinct from old.checked_at then
      raise exception 'trend_decision_needs_new_timestamp';
    end if;
  end if;
  new.recorded_at := now();
  return new;
end;
$$;

drop trigger if exists trend_observations_guard_revision on public.trend_observations;
create trigger trend_observations_guard_revision
  before insert on public.trend_observations
  for each row execute function public.trend_guard_observation_revision();

drop trigger if exists trend_observations_purge_only on public.trend_observations;
create trigger trend_observations_purge_only
  before delete on public.trend_observations
  for each row execute function public.trend_guard_purge_only();

drop trigger if exists trend_invalidations_immutable on public.trend_observation_invalidations;
create trigger trend_invalidations_immutable
  before update on public.trend_observation_invalidations
  for each row execute function public.trend_guard_immutable();

drop trigger if exists trend_invalidations_purge_only on public.trend_observation_invalidations;
create trigger trend_invalidations_purge_only
  before delete on public.trend_observation_invalidations
  for each row execute function public.trend_guard_purge_only();

drop trigger if exists trend_audit_events_immutable on public.trend_audit_events;
create trigger trend_audit_events_immutable
  before update on public.trend_audit_events
  for each row execute function public.trend_guard_immutable();

drop trigger if exists trend_audit_events_purge_only on public.trend_audit_events;
create trigger trend_audit_events_purge_only
  before delete on public.trend_audit_events
  for each row execute function public.trend_guard_purge_only();

drop trigger if exists trend_purge_runs_immutable on public.trend_purge_runs;
create trigger trend_purge_runs_immutable
  before update on public.trend_purge_runs
  for each row execute function public.trend_guard_immutable();

drop trigger if exists trend_purge_runs_purge_only on public.trend_purge_runs;
create trigger trend_purge_runs_purge_only
  before delete on public.trend_purge_runs
  for each row execute function public.trend_guard_purge_only();

drop trigger if exists trend_authorizations_decision_update on public.trend_source_authorizations;
create trigger trend_authorizations_decision_update
  before update on public.trend_source_authorizations
  for each row execute function public.trend_guard_decision_update();

drop trigger if exists trend_coverage_decision_update on public.trend_source_coverage;
create trigger trend_coverage_decision_update
  before update on public.trend_source_coverage
  for each row execute function public.trend_guard_decision_update();

drop trigger if exists trend_authorizations_audit on public.trend_source_authorizations;
create trigger trend_authorizations_audit
  after insert or update or delete on public.trend_source_authorizations
  for each row execute function public.trend_audit_policy_change();

drop trigger if exists trend_coverage_audit on public.trend_source_coverage;
create trigger trend_coverage_audit
  after insert or update or delete on public.trend_source_coverage
  for each row execute function public.trend_audit_policy_change();

-- The Stage 2A insert guard, now also enforcing the review periods, so the
-- backstop agrees with the RPC. (Restored to the Stage 2A version only by
-- the governance rollback followed by re-applying the storage file.)
create or replace function public.trend_guard_observation_insert()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
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
     where a.source_id = new.source_id and a.status = 'approved' and a.reference is not null
       and a.decided_at <= now() and a.decided_at > now() - public.trend_authorization_review_period()
  ) then
    raise exception 'trend_source_not_authorized';
  end if;
  if not exists (
    select 1 from public.trend_source_coverage c
     where c.source_id = new.source_id and c.platform = new.platform
       and c.country = new.country and c.status = 'verified'
       and c.checked_at <= now() and c.checked_at > now() - public.trend_coverage_review_period()
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

-- Sealing (Stage 2A) compared the row's xmin with the top-level transaction.
-- The RPC writes inside an exception block (a subtransaction), so it also
-- marks the observation it is completing with a transaction-local setting.
-- No API role holds INSERT on these tables, so only the definer RPC (or the
-- owner) can reach this path.
create or replace function public.trend_guard_metric_insert()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_obs record;
  v_def public.trend_metric_definitions%rowtype;
  v_unit text;
begin
  select o.source_id, o.retrieved_at, (o.xmin = pg_current_xact_id()::xid
            or current_setting('trend.open_observation', true) = o.id::text) as same_tx
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
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_obs record;
  v_requires_url boolean;
begin
  select o.source_id, (o.xmin = pg_current_xact_id()::xid
            or current_setting('trend.open_observation', true) = o.id::text) as same_tx
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

-- ─── Store RPC ────────────────────────────────────────────────────────────

create or replace function public.trend_store_observation(p_observation jsonb, p_replaces uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v jsonb := p_observation;
  v_source public.trend_sources%rowtype;
  v_platform text;
  v_country text;
  v_language text;
  v_kind text;
  v_text text;
  v_normalized text;
  v_item text;
  v_ws timestamptz;
  v_we timestamptz;
  v_retrieved timestamptz;
  v_expires timestamptz;
  v_delete timestamptz;
  v_revision smallint := 1;
  v_trend_key text;
  v_target public.trend_observations%rowtype;
  v_row public.trend_observations%rowtype;
  v_existing public.trend_observations%rowtype;
  v_metric record;
  v_evidence jsonb;
  v_incoming jsonb;
  v_stored jsonb;
  v_message text;
  v_constraint text;
begin
  -- Shape: a bounded object with exactly the allowed keys and string fields.
  if v is null or jsonb_typeof(v) <> 'object' or pg_column_size(v) > 65536 then
    return jsonb_build_object('status', 'rejected', 'code', 'invalid_payload');
  end if;
  if exists (select 1 from jsonb_object_keys(v) k where k not in (
       'source_id', 'platform', 'country', 'language', 'subject_kind', 'subject_text', 'subject_normalized',
       'provider_item_id', 'window_start', 'window_end', 'retrieved_at', 'metrics', 'evidence'))
     or exists (select 1 from unnest(array['source_id', 'platform', 'country', 'language', 'subject_kind', 'subject_text',
       'subject_normalized', 'window_start', 'window_end', 'retrieved_at']) f
       where jsonb_typeof(v -> f) is distinct from 'string')
     or jsonb_typeof(coalesce(v -> 'provider_item_id', 'null'::jsonb)) not in ('string', 'null')
     or jsonb_typeof(v -> 'metrics') is distinct from 'object'
     or jsonb_typeof(v -> 'evidence') is distinct from 'array' then
    return jsonb_build_object('status', 'rejected', 'code', 'invalid_payload');
  end if;

  v_platform := v ->> 'platform';
  v_country := v ->> 'country';
  v_language := v ->> 'language';
  v_kind := v ->> 'subject_kind';
  v_text := v ->> 'subject_text';
  v_normalized := v ->> 'subject_normalized';
  v_item := v ->> 'provider_item_id';
  begin
    v_ws := (v ->> 'window_start')::timestamptz;
    v_we := (v ->> 'window_end')::timestamptz;
    v_retrieved := (v ->> 'retrieved_at')::timestamptz;
  exception when others then
    return jsonb_build_object('status', 'rejected', 'code', 'invalid_payload');
  end;

  select * into v_source from public.trend_sources where source_id = v ->> 'source_id';
  if not found then
    return jsonb_build_object('status', 'rejected', 'code', 'unknown_source');
  end if;

  -- Current approval and coverage, locked so a concurrent revocation waits
  -- for this insert to finish (and the next insert then sees it).
  perform 1 from public.trend_source_authorizations a
    where a.source_id = v_source.source_id and a.status = 'approved'
      and a.reference is not null and a.decided_at <= now() and a.decided_at > now() - public.trend_authorization_review_period()
    for share;
  if not found then
    return jsonb_build_object('status', 'rejected', 'code', 'source_not_authorized');
  end if;
  perform 1 from public.trend_source_coverage c
    where c.source_id = v_source.source_id and c.platform = v_platform and c.country = v_country
      and c.status = 'verified' and c.checked_at <= now() and c.checked_at > now() - public.trend_coverage_review_period()
    for share;
  if not found then
    return jsonb_build_object('status', 'rejected', 'code', 'coverage_not_verified');
  end if;

  -- Freshness and deletion deadline from the source, never from the caller.
  v_expires := v_we + v_source.expires_after;
  v_delete := least(v_expires, v_retrieved + make_interval(days => v_source.max_retention_days));
  if v_expires <= now() or v_delete <= now() then
    return jsonb_build_object('status', 'rejected', 'code', 'observation_expired');
  end if;

  v_trend_key := case when v_item is null
    then 'topic|' || v_platform || '|' || v_country || '|' || v_language || '|' || v_kind || '|' || v_normalized
    else 'item|' || v_platform || '|' || v_country || '|' || v_language || '|' || v_kind || '|' || v_item end;

  -- A correction replaces the latest, invalidated revision of the SAME identity.
  if p_replaces is not null then
    select * into v_target from public.trend_observations where id = p_replaces for share;
    if not found
       or v_target.source_id <> v_source.source_id or v_target.trend_key <> v_trend_key
       or v_target.window_start <> v_ws or v_target.window_end <> v_we
       or not exists (select 1 from public.trend_observation_invalidations i where i.observation_id = v_target.id) then
      return jsonb_build_object('status', 'rejected', 'code', 'invalid_replacement');
    end if;
    v_revision := v_target.revision + 1;
  end if;

  -- Incoming content, in the same canonical form used for stored rows.
  begin
    v_incoming := jsonb_build_object(
      'subject_text', v_text,
      'retrieved_at', extract(epoch from v_retrieved),
      'metrics', coalesce((select jsonb_object_agg(k, jsonb_build_object(
          'status', m ->> 'status',
          'value', case when m ->> 'value' is null then null else ((m ->> 'value')::numeric)::text end,
          'definition_version', m ->> 'definition_version',
          'unavailable_reason', m ->> 'unavailable_reason'))
        from jsonb_each(v -> 'metrics') as x(k, m)), '{}'::jsonb),
      'evidence', coalesce((select jsonb_agg(jsonb_build_array(e ->> 'source_id', e ->> 'url', e ->> 'attribution',
          extract(epoch from (e ->> 'retrieved_at')::timestamptz)) order by e ->> 'source_id', e ->> 'url', e ->> 'attribution', e ->> 'retrieved_at')
        from jsonb_array_elements(v -> 'evidence') as y(e)), '[]'::jsonb));
  exception when others then
    return jsonb_build_object('status', 'rejected', 'code', 'invalid_payload');
  end;

  begin
    -- SET CONSTRAINTS lasts for the rest of the transaction, so start every
    -- write from the deferred default (an earlier call in the same
    -- transaction may have left the check immediate).
    set constraints public.trend_observations_complete deferred;
    insert into public.trend_observations (
      source_id, platform, country, language, subject_kind, subject_text, subject_normalized, provider_item_id,
      window_start, window_end, retrieved_at, fresh_until, stale_after, expires_at, freshness_basis, delete_after,
      revision, replaces_observation_id)
    values (
      v_source.source_id, v_platform, v_country, v_language, v_kind, v_text, v_normalized, v_item,
      v_ws, v_we, v_retrieved, v_we + v_source.fresh_for, v_we + v_source.stale_after, v_expires,
      'provisional_product_default', v_delete, v_revision, p_replaces)
    on conflict on constraint trend_observations_identity_key do nothing
    returning * into v_row;

    if v_row.id is null then
      -- Same identity already stored: compare with the latest revision.
      select * into v_existing from public.trend_observations
       where source_id = v_source.source_id and trend_key = v_trend_key and window_start = v_ws and window_end = v_we
       order by revision desc limit 1;
      if exists (select 1 from public.trend_observation_invalidations i where i.observation_id = v_existing.id) then
        return jsonb_build_object('status', 'invalidated', 'observation_id', v_existing.id, 'revision', v_existing.revision);
      end if;
      v_stored := jsonb_build_object(
        'subject_text', v_existing.subject_text,
        'retrieved_at', extract(epoch from v_existing.retrieved_at),
        'metrics', coalesce((select jsonb_object_agg(m.metric_key, jsonb_build_object(
            'status', m.status, 'value', m.value::text, 'definition_version', m.definition_version,
            'unavailable_reason', m.unavailable_reason))
          from public.trend_observation_metrics m where m.observation_id = v_existing.id), '{}'::jsonb),
        'evidence', coalesce((select jsonb_agg(jsonb_build_array(e.source_id, e.url, e.attribution, extract(epoch from e.retrieved_at))
            order by e.source_id, e.url, e.attribution, e.retrieved_at)
          from public.trend_evidence e where e.observation_id = v_existing.id), '[]'::jsonb));
      return jsonb_build_object(
        'status', case when v_stored = v_incoming then 'duplicate' else 'conflict' end,
        'observation_id', v_existing.id, 'revision', v_existing.revision,
        'item_key', v_existing.item_key, 'topic_key', v_existing.topic_key, 'trend_key', v_existing.trend_key);
    end if;

    perform set_config('trend.open_observation', v_row.id::text, true);

    -- Metrics: exactly the source's declared keys, each fully specified.
    if (select count(*) from jsonb_object_keys(v -> 'metrics'))
         <> (select count(distinct d.metric_key) from public.trend_metric_definitions d where d.source_id = v_source.source_id)
       or exists (select 1 from jsonb_each(v -> 'metrics') as x(k, m)
          where jsonb_typeof(m) <> 'object'
             or exists (select 1 from jsonb_object_keys(m) mk where mk not in ('status', 'value', 'definition_version', 'unavailable_reason'))
             or (m ? 'value' and jsonb_typeof(m -> 'value') <> 'null'
                 and (jsonb_typeof(m -> 'value') <> 'string' or (m ->> 'value') !~ '^[0-9]{1,40}(\.[0-9]{1,20})?$'))) then
      raise exception 'trend_invalid_metrics';
    end if;
    for v_metric in
      select x.k as key, x.m as body,
             (select d.unit from public.trend_metric_definitions d
               where d.source_id = v_source.source_id and d.metric_key = x.k limit 1) as unit
        from jsonb_each(v -> 'metrics') as x(k, m)
    loop
      if v_metric.unit is null then
        raise exception 'trend_unknown_metric';
      end if;
      insert into public.trend_observation_metrics
        (observation_id, metric_key, status, value, unit, definition_version, unavailable_reason)
      values (v_row.id, v_metric.key, v_metric.body ->> 'status', (v_metric.body ->> 'value')::numeric, v_metric.unit,
              v_metric.body ->> 'definition_version', v_metric.body ->> 'unavailable_reason');
    end loop;

    -- Evidence: 1..20 attributed entries with only the allowed keys.
    if jsonb_array_length(v -> 'evidence') not between 1 and 20 then
      raise exception 'trend_observation_missing_evidence';
    end if;
    for v_evidence in select e from jsonb_array_elements(v -> 'evidence') as y(e)
    loop
      if jsonb_typeof(v_evidence) <> 'object'
         or exists (select 1 from jsonb_object_keys(v_evidence) ek where ek not in ('source_id', 'url', 'attribution', 'retrieved_at'))
         or jsonb_typeof(v_evidence -> 'source_id') is distinct from 'string'
         or jsonb_typeof(v_evidence -> 'attribution') is distinct from 'string'
         or jsonb_typeof(v_evidence -> 'retrieved_at') is distinct from 'string'
         or jsonb_typeof(coalesce(v_evidence -> 'url', 'null'::jsonb)) not in ('string', 'null') then
        raise exception 'trend_invalid_evidence';
      end if;
      insert into public.trend_evidence (observation_id, source_id, attribution, url, retrieved_at)
      values (v_row.id, v_evidence ->> 'source_id', v_evidence ->> 'attribution', v_evidence ->> 'url',
              (v_evidence ->> 'retrieved_at')::timestamptz);
    end loop;

    -- Run the completeness check now, inside this block, so a failure rolls
    -- back everything above and is reported as a code.
    set constraints public.trend_observations_complete immediate;
    set constraints public.trend_observations_complete deferred;
    perform set_config('trend.open_observation', '', true);
  exception when others then
    get stacked diagnostics v_message = message_text, v_constraint = constraint_name;
    return jsonb_build_object('status', 'rejected', 'code',
      case
        when v_message ~ '^trend_[a-z_]+$' then substr(v_message, 7)
        when v_constraint ~ '^trend_[a-z_]+$' then substr(v_constraint, 7)
        else 'storage_failed'
      end);
  end;

  return jsonb_build_object(
    'status', 'stored', 'observation_id', v_row.id, 'revision', v_row.revision,
    'item_key', v_row.item_key, 'topic_key', v_row.topic_key, 'trend_key', v_row.trend_key,
    'expires_at', v_row.expires_at, 'delete_after', v_row.delete_after);
end;
$$;

-- ─── Read RPC ─────────────────────────────────────────────────────────────
-- The production read path: usable observations for one platform and
-- country (optionally one language), newest window first, with bounded
-- keyset pagination. Uses the database clock. Only rows that are, now:
-- from an approved source (within its review period) with verified coverage
-- for this market (within its review period), not invalidated, not expired,
-- not past their deletion deadline, and already retrieved.
-- Metric values are exact decimal strings; unavailable metrics have no value.

create or replace function public.trend_list_usable_observations(
  p_platform text,
  p_country text,
  p_language text default null,
  p_limit integer default 50,
  p_after_window_end timestamptz default null,
  p_after_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_sources text[];
  v_rows jsonb;
  v_count integer;
  v_cursor jsonb;
begin
  if p_platform is null or p_platform not in ('google_search', 'youtube', 'instagram', 'tiktok', 'web') then
    return jsonb_build_object('status', 'invalid_query', 'reason', 'invalid_platform');
  end if;
  if p_country is null or p_country !~ '^[A-Z]{2}$' then
    return jsonb_build_object('status', 'invalid_query', 'reason', 'invalid_country');
  end if;
  if p_language is not null and p_language not in
       ('und', 'en', 'ar', 'hi', 'zh-Hans', 'zh-Hant', 'tr', 'ms', 'id', 'th', 'vi', 'fil') then
    return jsonb_build_object('status', 'invalid_query', 'reason', 'invalid_language');
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    return jsonb_build_object('status', 'invalid_query', 'reason', 'invalid_limit');
  end if;
  if (p_after_window_end is null) <> (p_after_id is null) then
    return jsonb_build_object('status', 'invalid_query', 'reason', 'invalid_cursor');
  end if;

  select coalesce(array_agg(s.source_id order by s.source_id), '{}') into v_sources
    from public.trend_sources s
   where exists (
           select 1 from public.trend_source_authorizations a
            where a.source_id = s.source_id and a.status = 'approved' and a.reference is not null
              and a.decided_at <= now() and a.decided_at > now() - public.trend_authorization_review_period())
     and exists (
           select 1 from public.trend_source_coverage c
            where c.source_id = s.source_id and c.platform = p_platform and c.country = p_country
              and c.status = 'verified'
              and c.checked_at <= now() and c.checked_at > now() - public.trend_coverage_review_period());

  with page as (
    select o.*
      from public.trend_observations o
     where o.platform = p_platform and o.country = p_country
       and (p_language is null or o.language = p_language)
       and o.source_id = any (v_sources)
       and o.expires_at > now() and o.delete_after > now() and o.retrieved_at <= now()
       and not exists (select 1 from public.trend_observation_invalidations i where i.observation_id = o.id)
       and (p_after_window_end is null or (o.window_end, o.id) < (p_after_window_end, p_after_id))
     order by o.window_end desc, o.id desc
     limit p_limit + 1
  ),
  numbered as (
    select page.*, row_number() over (order by page.window_end desc, page.id desc) as n from page
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'storage_id', n.id,
      'source_id', n.source_id,
      'platform', n.platform,
      'country', n.country,
      'language', n.language,
      'subject_kind', n.subject_kind,
      'subject_text', n.subject_text,
      'subject_normalized', n.subject_normalized,
      'provider_item_id', n.provider_item_id,
      'item_key', n.item_key,
      'topic_key', n.topic_key,
      'trend_key', n.trend_key,
      'revision', n.revision,
      'window_start', n.window_start,
      'window_end', n.window_end,
      'retrieved_at', n.retrieved_at,
      'fresh_until', n.fresh_until,
      'stale_after', n.stale_after,
      'expires_at', n.expires_at,
      'freshness_basis', n.freshness_basis,
      'delete_after', n.delete_after,
      'metrics', coalesce((
        select jsonb_object_agg(m.metric_key, jsonb_build_object(
          'status', m.status, 'value', m.value::text, 'unit', m.unit,
          'definition_version', m.definition_version, 'unavailable_reason', m.unavailable_reason))
          from public.trend_observation_metrics m where m.observation_id = n.id), '{}'::jsonb),
      'evidence', coalesce((
        select jsonb_agg(jsonb_build_object(
          'source_id', e.source_id, 'url', e.url, 'attribution', e.attribution, 'retrieved_at', e.retrieved_at)
          order by e.retrieved_at, e.id)
          from public.trend_evidence e where e.observation_id = n.id), '[]'::jsonb))
      order by n.n) filter (where n.n <= p_limit), '[]'::jsonb),
    count(*)
    into v_rows, v_count
    from numbered n;

  -- More rows exist: the cursor is the last returned row's sort key.
  if v_count > p_limit then
    select jsonb_build_object('window_end', o.window_end, 'id', o.id) into v_cursor
      from public.trend_observations o
     where o.id = ((v_rows -> (p_limit - 1)) ->> 'storage_id')::uuid;
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'permitted_source_ids', to_jsonb(v_sources),
    'observations', v_rows,
    'next_cursor', v_cursor);
end;
$$;

-- ─── Invalidation RPC ─────────────────────────────────────────────────────
-- DISABLED FOR API ROLES. Only authorized Voom staff may invalidate, and no
-- staff-authorization source exists in this codebase yet (the Admin Panel's
-- MFA admin memberships are unmerged). Until one exists and this function
-- verifies the actor against it, EXECUTE is granted to no API role: only the
-- database owner can run it, from a reviewed operational script.

create or replace function public.trend_invalidate_observation(
  p_observation_id uuid, p_reason_code text, p_actor text, p_reference text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_obs public.trend_observations%rowtype;
  v_at timestamptz;
begin
  if p_observation_id is null
     or p_reason_code is null or p_reason_code not in
       ('wrong_evidence', 'wrong_item', 'wrong_market', 'wrong_metric', 'source_withdrawn', 'other_verified_error')
     or p_actor is null or p_actor !~ '^[A-Za-z0-9._:-]{1,120}$'
     or p_reference is null or p_reference !~ '^[A-Za-z0-9._:#-]{1,120}$' then
    return jsonb_build_object('status', 'rejected', 'code', 'invalid_request');
  end if;
  select * into v_obs from public.trend_observations where id = p_observation_id for share;
  if not found then
    return jsonb_build_object('status', 'rejected', 'code', 'not_found');
  end if;
  insert into public.trend_observation_invalidations (observation_id, reason_code, actor, reference)
  values (v_obs.id, p_reason_code, p_actor, p_reference)
  on conflict (observation_id) do nothing
  returning invalidated_at into v_at;
  if v_at is null then
    return jsonb_build_object('status', 'already_invalidated', 'observation_id', v_obs.id);
  end if;
  -- The audit copy holds ids and codes only: no subject, item id, URL or metric.
  insert into public.trend_audit_events
    (event_type, db_role, actor, source_id, observation_id, previous, next, reference)
  values ('observation_invalidated', current_user, p_actor, v_obs.source_id, v_obs.id,
          jsonb_build_object('state', 'valid', 'revision', v_obs.revision),
          jsonb_build_object('state', 'invalidated', 'reason_code', p_reason_code),
          p_reference);
  return jsonb_build_object('status', 'invalidated', 'observation_id', v_obs.id, 'revision', v_obs.revision, 'invalidated_at', v_at);
end;
$$;

-- ─── Retention ────────────────────────────────────────────────────────────
-- Replaces the Stage 2A purge body: same contract (bounded, database clock
-- only), plus the purge flag the delete guards require.

create or replace function public.trend_purge_expired(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_deleted integer;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'trend_invalid_purge_limit';
  end if;
  perform set_config('trend.purge', 'on', true);
  with doomed as (
    select o.id from public.trend_observations o
     where o.delete_after <= now()
     order by o.delete_after, o.id
     limit p_limit
     for update skip locked
  )
  delete from public.trend_observations o using doomed where o.id = doomed.id;
  get diagnostics v_deleted = row_count;
  perform set_config('trend.purge', 'off', true);
  return v_deleted;
end;
$$;

-- One bounded retention pass. Records the run (success or failure) and
-- returns what is still overdue. Takes no time argument: nothing can be
-- deleted before its deadline. Audit events are kept 730 days and purge-run
-- records 90 days.
create or replace function public.trend_run_retention_purge(p_limit integer default 500)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_started timestamptz := clock_timestamp();
  v_observations integer := 0;
  v_audit integer := 0;
  v_runs integer := 0;
  v_error text;
  v_message text;
  v_remaining integer;
  v_oldest timestamptz;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    return jsonb_build_object('status', 'rejected', 'code', 'invalid_limit');
  end if;
  begin
    v_observations := public.trend_purge_expired(p_limit);
    perform set_config('trend.purge', 'on', true);
    with doomed as (
      select a.id from public.trend_audit_events a
       where a.occurred_at <= now() - public.trend_audit_retention_period()
       order by a.occurred_at, a.seq limit p_limit
    )
    delete from public.trend_audit_events a using doomed where a.id = doomed.id;
    get diagnostics v_audit = row_count;
    with doomed as (
      select r.id from public.trend_purge_runs r
       where r.finished_at <= now() - public.trend_purge_run_retention_period()
       order by r.finished_at, r.id limit p_limit
    )
    delete from public.trend_purge_runs r using doomed where r.id = doomed.id;
    get diagnostics v_runs = row_count;
    perform set_config('trend.purge', 'off', true);
  exception when others then
    get stacked diagnostics v_message = message_text;
    v_error := case when v_message ~ '^trend_[a-z_]+$' then v_message else 'purge_failed' end;
    v_observations := 0;
    v_audit := 0;
    v_runs := 0;
  end;

  select count(*)::integer, min(delete_after) into v_remaining, v_oldest
    from (select delete_after from public.trend_observations where delete_after <= now() limit 100000) overdue;

  insert into public.trend_purge_runs
    (started_at, finished_at, status, batch_limit, observations_deleted, audit_events_deleted, purge_runs_deleted,
     remaining_overdue, oldest_overdue_at, error_code)
  values (v_started, clock_timestamp(), case when v_error is null then 'succeeded' else 'failed' end, p_limit,
          v_observations, v_audit, v_runs, v_remaining, v_oldest, v_error);

  return jsonb_build_object(
    'status', case when v_error is null then 'succeeded' else 'failed' end,
    'code', v_error,
    'observations_deleted', v_observations,
    'audit_events_deleted', v_audit,
    'remaining_overdue', v_remaining,
    'oldest_overdue_at', v_oldest);
end;
$$;

-- Retention health for monitoring. `breach` is true when any row is more
-- than 24 hours past its deadline, or any YouTube row is past the 30-day
-- policy limit.
create or replace function public.trend_retention_status()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select jsonb_build_object(
    'overdue', (select count(*) from (select 1 from public.trend_observations where delete_after <= now() limit 100000) x),
    'oldest_overdue_at', (select min(delete_after) from public.trend_observations where delete_after <= now()),
    'youtube_policy_breach', exists (
      select 1 from public.trend_observations
       where source_id = 'youtube_data_api' and retrieved_at + interval '30 days' <= now()),
    'breach', exists (select 1 from public.trend_observations where delete_after <= now() - interval '24 hours')
      or exists (select 1 from public.trend_observations
                  where source_id = 'youtube_data_api' and retrieved_at + interval '30 days' <= now()),
    'last_success_at', (select max(finished_at) from public.trend_purge_runs where status = 'succeeded'),
    'last_failure_at', (select max(finished_at) from public.trend_purge_runs where status = 'failed'),
    'last_failure_code', (select error_code from public.trend_purge_runs where status = 'failed' order by finished_at desc limit 1));
$$;

-- ─── Privileges ───────────────────────────────────────────────────────────

alter table public.trend_observation_invalidations enable row level security;
alter table public.trend_audit_events enable row level security;
alter table public.trend_purge_runs enable row level security;

revoke all on table public.trend_observation_invalidations, public.trend_audit_events, public.trend_purge_runs
  from public, anon, authenticated, service_role;
grant select on table public.trend_observation_invalidations, public.trend_audit_events, public.trend_purge_runs
  to service_role;
revoke all on sequence public.trend_audit_events_seq_seq from public, anon, authenticated, service_role;

-- Writes now go only through the RPC.
revoke insert on table public.trend_observations, public.trend_observation_metrics, public.trend_evidence from service_role;

revoke all on function public.trend_guard_observation_revision() from public, anon, authenticated, service_role;
revoke all on function public.trend_guard_purge_only() from public, anon, authenticated, service_role;
revoke all on function public.trend_audit_policy_change() from public, anon, authenticated, service_role;
revoke all on function public.trend_guard_decision_update() from public, anon, authenticated, service_role;
revoke all on function public.trend_purge_expired(integer) from public, anon, authenticated, service_role;

revoke all on function public.trend_guard_observation_insert() from public, anon, authenticated, service_role;
revoke all on function public.trend_guard_metric_insert() from public, anon, authenticated, service_role;
revoke all on function public.trend_guard_evidence_insert() from public, anon, authenticated, service_role;
revoke all on function public.trend_authorization_review_period() from public, anon, authenticated, service_role;
revoke all on function public.trend_coverage_review_period() from public, anon, authenticated, service_role;
revoke all on function public.trend_audit_retention_period() from public, anon, authenticated, service_role;
revoke all on function public.trend_purge_run_retention_period() from public, anon, authenticated, service_role;
revoke all on function public.trend_list_usable_observations(text, text, text, integer, timestamptz, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.trend_store_observation(jsonb, uuid) from public, anon, authenticated, service_role;
revoke all on function public.trend_invalidate_observation(uuid, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.trend_run_retention_purge(integer) from public, anon, authenticated, service_role;
revoke all on function public.trend_retention_status() from public, anon, authenticated, service_role;
grant execute on function public.trend_store_observation(jsonb, uuid) to service_role;
grant execute on function public.trend_list_usable_observations(text, text, text, integer, timestamptz, uuid) to service_role;
grant execute on function public.trend_run_retention_purge(integer) to service_role;
grant execute on function public.trend_retention_status() to service_role;

commit;
