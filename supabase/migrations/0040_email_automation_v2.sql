-- 0040_email_automation_v2.sql
-- Email Automation v2 — lifecycle email flows (Welcome / Re-engagement).
--
-- This is a NEW concept, deliberately separate from the two that already exist:
--
--   Campaign           finite marketing mission       → voom_campaigns (0018/0020/0033)
--   Standalone email   one intentional send           → voom_campaigns (kind = 'email')
--   Email flow         persistent lifecycle rule      → THIS migration
--
-- A flow is never a campaign: it has no start/end date, no per-action
-- Instagram siblings and no campaign_recipients rows. It has a trigger, an
-- eligibility rule, an ordered sequence of email steps, and durable
-- enrollments that move through that sequence over time.
--
-- Additive and non-destructive. Nothing here deletes data, edits migrations
-- 0036-0039, sends email, calls a provider, enqueues paid media, spends a
-- credit or schedules a cron.
--
-- Durable concepts added:
--   1. voom_email_flows            the flow definition (trigger, audience, status, revision)
--   2. voom_email_flow_steps       the sequence for one flow revision
--   3. voom_email_flow_enrollments which contact is in which flow, at which step
--   4. voom_email_flow_step_runs   one durable send per enrollment step (idempotent)
--   5. voom_email_flow_delivery_events  provider webhook evidence per flow send
--   6. voom_email_flow_events      truthful activity log for the flow detail screen
--   7. voom_email_suppressions     durable bounce/complaint suppression (see below)
--
-- Truthfulness rules encoded in the schema (mirrors 0018):
--   - 'accepted' means the provider accepted the message; 'delivered' is only
--     ever reachable through a verified provider delivery event;
--   - a step run is unique per (enrollment, position), so a retry or a second
--     cron invocation can never create a second send for the same step;
--   - the content actually sent is snapshotted on the run, so later edits to
--     the flow can never rewrite history.
--
-- voom_email_suppressions also fixes a real gap in the existing email
-- infrastructure: a Resend bounce/complaint previously marked ONE campaign
-- send failed and left the contact 'subscribed', so the next send went to the
-- same dead address again. Suppression is now durable per owner + address and
-- every lifecycle send fails closed against it.

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) voom_email_flows — the lifecycle rule
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.voom_email_flows (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete cascade,

  -- Flow taxonomy. v2 ships two flow types; the trigger/flow pairing is
  -- constrained so an unsupported combination cannot be stored, and a new
  -- flow type is added by extending these two checks plus the TS registry.
  flow_type text not null check (flow_type in ('welcome', 're_engagement')),
  trigger_type text not null check (
    trigger_type in ('newly_eligible_contact', 'inactive_contact')
  ),
  -- Per-type trigger parameters (e.g. {"inactivityDays":45}). Validated by the
  -- writer RPC; stored as jsonb so a new type needs no column.
  trigger_config jsonb not null default '{}'::jsonb,

  name text not null check (char_length(name) between 1 and 160),
  objective text not null default '' check (char_length(objective) <= 1000),

  -- Optional audience scope. Null = every eligible email subscriber.
  audience_id uuid,

  -- draft    created, nothing can enroll or send
  -- active   the owner activated it; enrollments and scheduled steps may run
  -- paused   nothing new sends; history is untouched
  -- archived terminal; nothing runs, history is kept
  status text not null default 'draft'
    check (status in ('draft', 'active', 'paused', 'archived')),

  -- Re-entry behaviour, per flow type (see lib/email-flows/policy.ts):
  --   once_per_contact  Welcome: one enrollment per contact per flow, ever
  --   cooldown          Re-engagement: re-entry only after cooldown_days
  reentry_policy text not null default 'once_per_contact'
    check (reentry_policy in ('once_per_contact', 'cooldown')),
  cooldown_days integer check (cooldown_days is null or cooldown_days between 1 and 365),

  -- Simple durable revision model. Editing a flow's content writes a NEW
  -- revision; enrollments stay pinned to the revision they enrolled on, so an
  -- edit can never change a message that is already scheduled or sent.
  current_revision integer not null default 1 check (current_revision between 1 and 1000),

  generation_source text not null default 'deterministic'
    check (generation_source in ('deterministic', 'mara')),
  strategy jsonb,
  strategy_summary text check (strategy_summary is null or char_length(strategy_summary) between 1 and 400),

  -- 'coordinator' rows are MARA proposals. They are always drafts and are
  -- deduplicated per owner + flow type by the partial unique index below.
  created_by text not null default 'user' check (created_by in ('user', 'coordinator')),
  idempotency_key text check (idempotency_key is null or char_length(idempotency_key) between 16 and 200),

  -- Activation is only ever an explicit owner action (activated_by = 'user').
  -- There is no code path that stores another value: Autopilot fails closed.
  activated_at timestamptz,
  activated_by text check (activated_by is null or activated_by = 'user'),
  paused_at timestamptz,
  archived_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, owner_user_id),
  unique (owner_user_id, idempotency_key),

  foreign key (audience_id, owner_user_id)
    references public.audiences (id, owner_id)
    on delete set null (audience_id),

  -- A flow type only ever runs on its own trigger.
  constraint voom_email_flows_type_trigger_pairing check (
    (flow_type = 'welcome' and trigger_type = 'newly_eligible_contact')
    or (flow_type = 're_engagement' and trigger_type = 'inactive_contact')
  ),
  -- A cooldown policy is meaningless without a cooldown length.
  constraint voom_email_flows_cooldown_requires_days check (
    reentry_policy <> 'cooldown' or cooldown_days is not null
  ),
  -- An active flow was activated by the owner; a paused flow was activated too.
  constraint voom_email_flows_active_requires_activation check (
    status not in ('active', 'paused') or activated_at is not null
  ),
  constraint voom_email_flows_archived_requires_archived_at check (
    status <> 'archived' or archived_at is not null
  )
);

create index if not exists voom_email_flows_owner_status_idx
  on public.voom_email_flows (owner_user_id, status, created_at desc);

-- The duplicate-proposal guarantee: one live coordinator proposal per owner
-- per flow type. A repeated Coordinator run cannot insert a second Welcome
-- proposal, even concurrently.
create unique index if not exists voom_email_flows_one_live_coordinator_proposal_idx
  on public.voom_email_flows (owner_user_id, flow_type)
  where created_by = 'coordinator' and status <> 'archived';

drop trigger if exists set_voom_email_flows_updated_at on public.voom_email_flows;
create trigger set_voom_email_flows_updated_at
  before update on public.voom_email_flows
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) voom_email_flow_steps — the sequence for one revision
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.voom_email_flow_steps (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  flow_id uuid not null,
  revision integer not null check (revision between 1 and 1000),
  position integer not null check (position between 0 and 11),
  -- v2 only sends email. The column exists so a future flow type can add a
  -- non-email step without rewriting the engine.
  step_type text not null default 'email' check (step_type in ('email')),

  title text not null check (char_length(title) between 1 and 160),
  purpose text not null default '' check (char_length(purpose) <= 1000),

  -- Deterministic wait BEFORE this step, measured from the previous step (or
  -- from enrollment for position 0). Bounded here and again in the writer.
  wait_minutes integer not null default 0 check (wait_minutes between 0 and 20160),

  subject text not null check (char_length(subject) between 1 and 300),
  preview_text text not null default '' check (char_length(preview_text) <= 500),
  body text not null check (char_length(body) between 1 and 12000),
  cta text not null default '' check (char_length(cta) <= 160),
  cta_url text check (cta_url is null or char_length(cta_url) <= 500),
  content_source text not null default 'deterministic'
    check (content_source in ('deterministic', 'mara', 'edited')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, owner_user_id),
  unique (owner_user_id, flow_id, revision, position),
  foreign key (flow_id, owner_user_id)
    references public.voom_email_flows (id, owner_user_id) on delete cascade
);

create index if not exists voom_email_flow_steps_flow_revision_idx
  on public.voom_email_flow_steps (owner_user_id, flow_id, revision, position);

drop trigger if exists set_voom_email_flow_steps_updated_at on public.voom_email_flow_steps;
create trigger set_voom_email_flow_steps_updated_at
  before update on public.voom_email_flow_steps
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) voom_email_flow_enrollments — who is in the flow, and where they are
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.voom_email_flow_enrollments (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  flow_id uuid not null,
  contact_id uuid not null,
  -- The flow revision this contact enrolled on. Never rewritten: an edit to
  -- the flow creates a new revision for FUTURE enrollments only.
  revision integer not null check (revision between 1 and 1000),

  status text not null default 'active'
    check (status in ('active', 'completed', 'stopped')),
  stop_reason text check (stop_reason is null or char_length(stop_reason) <= 120),

  enrolled_at timestamptz not null default now(),
  current_position integer not null default 0 check (current_position between 0 and 11),
  -- The next instant this enrollment may execute. Always in the future while
  -- the enrollment is active (enforced by the writers, never by the browser).
  next_eligible_at timestamptz,
  last_step_at timestamptz,
  completed_at timestamptz,
  stopped_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, owner_user_id),
  foreign key (flow_id, owner_user_id)
    references public.voom_email_flows (id, owner_user_id) on delete cascade,
  foreign key (contact_id, owner_user_id)
    references public.contacts (id, owner_id) on delete cascade,
  constraint voom_email_flow_enrollments_stop_reason check (
    status <> 'stopped' or stop_reason is not null
  )
);

-- One live enrollment per contact per flow. This is what makes a duplicate
-- cron enrollment structurally impossible, even for two racing workers; the
-- re-entry rule (once-per-contact vs cooldown) is applied by the writer on top
-- of it, so a completed Welcome enrollment still blocks a second one while a
-- completed Re-engagement enrollment may re-enter after its cooldown.
create unique index if not exists voom_email_flow_enrollments_one_active_idx
  on public.voom_email_flow_enrollments (owner_user_id, flow_id, contact_id)
  where status = 'active';

create index if not exists voom_email_flow_enrollments_flow_status_idx
  on public.voom_email_flow_enrollments (owner_user_id, flow_id, status, enrolled_at desc);
create index if not exists voom_email_flow_enrollments_due_idx
  on public.voom_email_flow_enrollments (owner_user_id, next_eligible_at)
  where status = 'active';

drop trigger if exists set_voom_email_flow_enrollments_updated_at on public.voom_email_flow_enrollments;
create trigger set_voom_email_flow_enrollments_updated_at
  before update on public.voom_email_flow_enrollments
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) voom_email_flow_step_runs — one durable, idempotent send per step
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.voom_email_flow_step_runs (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  flow_id uuid not null,
  enrollment_id uuid not null,
  step_id uuid,
  revision integer not null check (revision between 1 and 1000),
  position integer not null check (position between 0 and 11),

  -- scheduled → sending → accepted → delivered
  --                     ↘ failed / skipped (terminal)
  -- 'accepted' is provider acceptance only. 'delivered' requires a verified
  -- provider delivery event, exactly like campaign_sends in 0018.
  status text not null default 'scheduled'
    check (status in ('scheduled', 'sending', 'accepted', 'delivered', 'failed', 'skipped')),
  provider text not null default 'resend' check (provider in ('resend')),
  provider_message_id text check (provider_message_id is null or char_length(provider_message_id) between 1 and 200),
  provider_status text check (provider_status is null or char_length(provider_status) <= 120),

  idempotency_key text not null check (char_length(idempotency_key) between 16 and 200),
  -- Bounded retry: the claim writer refuses to exceed this.
  attempts integer not null default 0 check (attempts between 0 and 5),
  last_error_code text check (last_error_code is null or char_length(last_error_code) <= 120),
  last_error_message text check (last_error_message is null or char_length(last_error_message) <= 1000),

  scheduled_for timestamptz not null,
  claimed_at timestamptz,
  accepted_at timestamptz,
  delivered_at timestamptz,

  -- What was actually handed to the provider, frozen at claim time. Later flow
  -- edits cannot reach it, so sent history is immutable.
  content_snapshot jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, owner_user_id),
  unique (owner_user_id, idempotency_key),
  -- THE double-send guard: exactly one run per enrollment step, ever.
  unique (owner_user_id, enrollment_id, position),

  foreign key (flow_id, owner_user_id)
    references public.voom_email_flows (id, owner_user_id) on delete cascade,
  foreign key (enrollment_id, owner_user_id)
    references public.voom_email_flow_enrollments (id, owner_user_id) on delete cascade,
  foreign key (step_id, owner_user_id)
    references public.voom_email_flow_steps (id, owner_user_id) on delete set null (step_id),

  constraint voom_email_flow_step_runs_claim_consistency check (
    claimed_at is not null or status not in ('sending', 'accepted', 'delivered')
  ),
  constraint voom_email_flow_step_runs_accepted_consistency check (
    accepted_at is not null or status not in ('accepted', 'delivered')
  ),
  constraint voom_email_flow_step_runs_delivered_consistency check (
    delivered_at is not null or status <> 'delivered'
  )
);

create unique index if not exists voom_email_flow_step_runs_provider_message_idx
  on public.voom_email_flow_step_runs (provider, provider_message_id)
  where provider_message_id is not null;
create index if not exists voom_email_flow_step_runs_due_idx
  on public.voom_email_flow_step_runs (owner_user_id, scheduled_for)
  where status = 'scheduled';
create index if not exists voom_email_flow_step_runs_inflight_idx
  on public.voom_email_flow_step_runs (owner_user_id, updated_at)
  where status in ('sending');
create index if not exists voom_email_flow_step_runs_flow_idx
  on public.voom_email_flow_step_runs (owner_user_id, flow_id, created_at desc);

drop trigger if exists set_voom_email_flow_step_runs_updated_at on public.voom_email_flow_step_runs;
create trigger set_voom_email_flow_step_runs_updated_at
  before update on public.voom_email_flow_step_runs
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) voom_email_flow_delivery_events — provider evidence
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.voom_email_flow_delivery_events (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  send_id uuid not null,
  provider text not null check (provider in ('resend')),
  event_id text not null check (char_length(event_id) between 1 and 200),
  event_type text not null check (char_length(event_type) between 1 and 120),
  received_at timestamptz not null default now(),
  unique (id, owner_user_id),
  -- Provider event replay is deduplicated per owner, exactly like 0018.
  unique (owner_user_id, provider, event_id),
  foreign key (send_id, owner_user_id)
    references public.voom_email_flow_step_runs (id, owner_user_id) on delete cascade
);

create index if not exists voom_email_flow_delivery_events_send_idx
  on public.voom_email_flow_delivery_events (send_id, received_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6) voom_email_flow_events — truthful activity log
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.voom_email_flow_events (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  flow_id uuid not null,
  enrollment_id uuid,
  kind text not null check (kind in (
    'flow_created', 'flow_activated', 'flow_paused', 'flow_resumed',
    'flow_archived', 'flow_revised',
    'contact_enrolled', 'enrollment_completed', 'enrollment_stopped',
    'step_scheduled', 'provider_accepted', 'delivered', 'send_failed', 'send_skipped'
  )),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (id, owner_user_id),
  foreign key (flow_id, owner_user_id)
    references public.voom_email_flows (id, owner_user_id) on delete cascade,
  foreign key (enrollment_id, owner_user_id)
    references public.voom_email_flow_enrollments (id, owner_user_id) on delete cascade
);

create index if not exists voom_email_flow_events_flow_idx
  on public.voom_email_flow_events (owner_user_id, flow_id, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 7) voom_email_suppressions — durable bounce/complaint suppression
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.voom_email_suppressions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  email text not null check (
    email = lower(trim(email))
    and char_length(email) <= 320
    and email ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'
  ),
  reason text not null check (reason in ('bounced', 'complained', 'failed', 'manual')),
  provider text check (provider is null or provider in ('resend')),
  provider_event_id text check (provider_event_id is null or char_length(provider_event_id) <= 200),
  detail text check (detail is null or char_length(detail) <= 1000),
  created_at timestamptz not null default now(),
  unique (owner_id, email, reason)
);

create index if not exists voom_email_suppressions_owner_email_idx
  on public.voom_email_suppressions (owner_id, email);

-- ─────────────────────────────────────────────────────────────────────────────
-- Row Level Security — owner-scoped reads, service-role writes
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.voom_email_flows enable row level security;
alter table public.voom_email_flow_steps enable row level security;
alter table public.voom_email_flow_enrollments enable row level security;
alter table public.voom_email_flow_step_runs enable row level security;
alter table public.voom_email_flow_delivery_events enable row level security;
alter table public.voom_email_flow_events enable row level security;
alter table public.voom_email_suppressions enable row level security;

revoke all on table public.voom_email_flows, public.voom_email_flow_steps,
  public.voom_email_flow_enrollments, public.voom_email_flow_step_runs,
  public.voom_email_flow_delivery_events, public.voom_email_flow_events,
  public.voom_email_suppressions from public, anon, authenticated;

-- The browser may read its own flows; every write goes through the
-- service-role RPCs below. There is no authenticated insert/update/delete
-- anywhere in Email Automation v2.
grant select on table public.voom_email_flows to authenticated;
grant select on table public.voom_email_flow_steps to authenticated;
grant select on table public.voom_email_flow_enrollments to authenticated;
grant select on table public.voom_email_flow_step_runs to authenticated;
grant select on table public.voom_email_flow_events to authenticated;
grant select on table public.voom_email_suppressions to authenticated;

grant select, insert, update, delete on table public.voom_email_flows to service_role;
grant select, insert, update, delete on table public.voom_email_flow_steps to service_role;
grant select, insert, update, delete on table public.voom_email_flow_enrollments to service_role;
grant select, insert, update, delete on table public.voom_email_flow_step_runs to service_role;
grant select, insert on table public.voom_email_flow_delivery_events to service_role;
grant select, insert, update on table public.voom_email_flow_events to service_role;
grant select, insert, update, delete on table public.voom_email_suppressions to service_role;

drop policy if exists "voom_email_flows_select_own" on public.voom_email_flows;
create policy "voom_email_flows_select_own" on public.voom_email_flows
  for select to authenticated using ((select auth.uid()) = owner_user_id);
drop policy if exists "voom_email_flow_steps_select_own" on public.voom_email_flow_steps;
create policy "voom_email_flow_steps_select_own" on public.voom_email_flow_steps
  for select to authenticated using ((select auth.uid()) = owner_user_id);
drop policy if exists "voom_email_flow_enrollments_select_own" on public.voom_email_flow_enrollments;
create policy "voom_email_flow_enrollments_select_own" on public.voom_email_flow_enrollments
  for select to authenticated using ((select auth.uid()) = owner_user_id);
drop policy if exists "voom_email_flow_step_runs_select_own" on public.voom_email_flow_step_runs;
create policy "voom_email_flow_step_runs_select_own" on public.voom_email_flow_step_runs
  for select to authenticated using ((select auth.uid()) = owner_user_id);
drop policy if exists "voom_email_flow_events_select_own" on public.voom_email_flow_events;
create policy "voom_email_flow_events_select_own" on public.voom_email_flow_events
  for select to authenticated using ((select auth.uid()) = owner_user_id);
drop policy if exists "voom_email_suppressions_select_own" on public.voom_email_suppressions;
create policy "voom_email_suppressions_select_own" on public.voom_email_suppressions
  for select to authenticated using ((select auth.uid()) = owner_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Writer RPCs — the only write path, service_role only
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Create a flow + its first revision atomically and idempotently.
create or replace function public.create_email_flow(
  p_owner_user_id uuid,
  p_payload jsonb
) returns public.voom_email_flows
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_flow_type text;
  v_trigger_type text;
  v_created_by text;
  v_idempotency_key text;
  v_steps jsonb;
  v_step jsonb;
  v_position integer;
  v_count integer;
  v_flow public.voom_email_flows;
begin
  if p_owner_user_id is null then
    raise exception 'owner_required';
  end if;

  v_flow_type := lower(trim(coalesce(p_payload ->> 'flowType', '')));
  v_trigger_type := lower(trim(coalesce(p_payload ->> 'triggerType', '')));
  v_created_by := lower(trim(coalesce(p_payload ->> 'createdBy', 'user')));
  v_idempotency_key := nullif(trim(coalesce(p_payload ->> 'idempotencyKey', '')), '');
  v_steps := coalesce(p_payload -> 'steps', '[]'::jsonb);

  -- Unsupported trigger types are refused here AND by the table check, so a
  -- caller cannot widen the taxonomy from the API layer.
  if v_flow_type not in ('welcome', 're_engagement') then
    raise exception 'unsupported_flow_type';
  end if;
  if v_trigger_type not in ('newly_eligible_contact', 'inactive_contact') then
    raise exception 'unsupported_trigger_type';
  end if;
  if (v_flow_type = 'welcome' and v_trigger_type <> 'newly_eligible_contact')
     or (v_flow_type = 're_engagement' and v_trigger_type <> 'inactive_contact') then
    raise exception 'trigger_type_mismatch';
  end if;
  if v_created_by not in ('user', 'coordinator') then
    raise exception 'invalid_created_by';
  end if;
  if v_idempotency_key is null or char_length(v_idempotency_key) < 16 then
    raise exception 'invalid_idempotency_key';
  end if;
  if jsonb_typeof(v_steps) <> 'array' or jsonb_array_length(v_steps) < 1 then
    raise exception 'flow_requires_steps';
  end if;
  -- Absolute structural ceiling. Per-type minimums/maximums are enforced by
  -- the deterministic policy layer before this call.
  if jsonb_array_length(v_steps) > 12 then
    raise exception 'too_many_flow_steps';
  end if;

  -- Idempotent replay: the same key returns the stored flow and writes nothing.
  select * into v_flow
  from public.voom_email_flows
  where owner_user_id = p_owner_user_id
    and idempotency_key = v_idempotency_key;
  if found then
    return v_flow;
  end if;

  -- A coordinator proposal can never duplicate a live flow of the same type.
  if v_created_by = 'coordinator' then
    perform 1
    from public.voom_email_flows
    where owner_user_id = p_owner_user_id
      and flow_type = v_flow_type
      and status <> 'archived';
    if found then
      raise exception 'flow_type_already_exists';
    end if;
  end if;

  insert into public.voom_email_flows (
    owner_user_id, business_id, flow_type, trigger_type, trigger_config,
    name, objective, audience_id, status, reentry_policy, cooldown_days,
    current_revision, generation_source, strategy, strategy_summary,
    created_by, idempotency_key
  ) values (
    p_owner_user_id,
    nullif(trim(coalesce(p_payload ->> 'businessId', '')), '')::uuid,
    v_flow_type,
    v_trigger_type,
    coalesce(p_payload -> 'triggerConfig', '{}'::jsonb),
    left(trim(coalesce(p_payload ->> 'name', '')), 160),
    left(trim(coalesce(p_payload ->> 'objective', '')), 1000),
    nullif(trim(coalesce(p_payload ->> 'audienceId', '')), '')::uuid,
    'draft',
    coalesce(nullif(trim(coalesce(p_payload ->> 'reentryPolicy', '')), ''), 'once_per_contact'),
    nullif(p_payload ->> 'cooldownDays', '')::integer,
    1,
    case when lower(coalesce(p_payload ->> 'generationSource', 'deterministic')) = 'mara'
         then 'mara' else 'deterministic' end,
    p_payload -> 'strategy',
    nullif(trim(coalesce(p_payload ->> 'strategySummary', '')), ''),
    v_created_by,
    v_idempotency_key
  )
  returning * into v_flow;

  v_position := 0;
  for v_step in select * from jsonb_array_elements(v_steps)
  loop
    if char_length(coalesce(v_step ->> 'subject', '')) not between 1 and 300 then
      raise exception 'invalid_step_subject';
    end if;
    if char_length(coalesce(v_step ->> 'body', '')) not between 1 and 12000 then
      raise exception 'invalid_step_body';
    end if;
    if coalesce((v_step ->> 'waitMinutes')::integer, 0) not between 0 and 20160 then
      raise exception 'invalid_step_wait';
    end if;

    insert into public.voom_email_flow_steps (
      owner_user_id, flow_id, revision, position, step_type,
      title, purpose, wait_minutes, subject, preview_text, body, cta, cta_url, content_source
    ) values (
      p_owner_user_id, v_flow.id, 1, v_position, 'email',
      left(trim(coalesce(v_step ->> 'title', v_step ->> 'subject', '')), 160),
      left(trim(coalesce(v_step ->> 'purpose', '')), 1000),
      greatest(0, coalesce((v_step ->> 'waitMinutes')::integer, 0)),
      left(trim(v_step ->> 'subject'), 300),
      left(trim(coalesce(v_step ->> 'previewText', '')), 500),
      v_step ->> 'body',
      left(trim(coalesce(v_step ->> 'cta', '')), 160),
      nullif(trim(coalesce(v_step ->> 'ctaUrl', '')), ''),
      case when lower(coalesce(v_step ->> 'contentSource', 'deterministic')) = 'mara'
           then 'mara' else 'deterministic' end
    );
    v_position := v_position + 1;
  end loop;

  select count(*) into v_count
  from public.voom_email_flow_steps
  where owner_user_id = p_owner_user_id and flow_id = v_flow.id and revision = 1;
  if v_count <> jsonb_array_length(v_steps) then
    raise exception 'flow_steps_not_persisted';
  end if;

  insert into public.voom_email_flow_events (owner_user_id, flow_id, kind, detail)
  values (p_owner_user_id, v_flow.id, 'flow_created', jsonb_build_object(
    'flowType', v_flow_type,
    'createdBy', v_created_by,
    'steps', jsonb_array_length(v_steps),
    'generationSource', v_flow.generation_source
  ));

  return v_flow;
end;
$$;

-- 2. Enroll one contact, consent-authoritative and race-safe.
--
-- Returns jsonb so expected refusals (already enrolled, cooling down,
-- ineligible) are values rather than exceptions:
--   {"outcome":"enrolled"|"already_enrolled"|"cooldown"|"ineligible"|"flow_inactive",
--    "enrollmentId":..., "reason":...}
create or replace function public.enroll_email_flow_contact(
  p_owner_user_id uuid,
  p_flow_id uuid,
  p_contact_id uuid,
  p_scheduled_for timestamptz,
  p_idempotency_key text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_flow public.voom_email_flows;
  v_contact public.contacts;
  v_existing public.voom_email_flow_enrollments;
  v_last_ended timestamptz;
  v_step public.voom_email_flow_steps;
  v_enrollment public.voom_email_flow_enrollments;
  v_suppressed integer;
begin
  -- Serialize concurrent enrollment attempts for this flow + contact pair.
  perform pg_advisory_xact_lock(
    hashtext('voom_email_flow_enroll:' || p_flow_id::text || ':' || p_contact_id::text)::bigint
  );

  select * into v_flow
  from public.voom_email_flows
  where id = p_flow_id and owner_user_id = p_owner_user_id
  for update;
  if not found then
    return jsonb_build_object('outcome', 'flow_inactive', 'reason', 'flow_not_found');
  end if;
  if v_flow.status <> 'active' then
    return jsonb_build_object('outcome', 'flow_inactive', 'reason', 'flow_status_' || v_flow.status);
  end if;

  if p_scheduled_for is null or p_scheduled_for <= now() then
    raise exception 'invalid_schedule';
  end if;
  if coalesce(p_idempotency_key, '') = '' or char_length(p_idempotency_key) < 16 then
    raise exception 'invalid_idempotency_key';
  end if;

  -- Consent is authoritative and read here, at enrollment time. Voom never
  -- infers marketing consent: only an explicit 'subscribed' status with a
  -- valid address passes, and a suppressed address never does.
  select * into v_contact
  from public.contacts
  where id = p_contact_id and owner_id = p_owner_user_id;
  if not found then
    return jsonb_build_object('outcome', 'ineligible', 'reason', 'contact_not_found');
  end if;
  if v_contact.email is null
     or v_contact.email_status <> 'subscribed'
     or v_contact.email !~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$' then
    return jsonb_build_object('outcome', 'ineligible', 'reason', 'consent_or_destination_not_verified');
  end if;

  select count(*) into v_suppressed
  from public.voom_email_suppressions
  where owner_id = p_owner_user_id and email = v_contact.email;
  if v_suppressed > 0 then
    return jsonb_build_object('outcome', 'ineligible', 'reason', 'suppressed');
  end if;

  select * into v_existing
  from public.voom_email_flow_enrollments
  where owner_user_id = p_owner_user_id
    and flow_id = p_flow_id
    and contact_id = p_contact_id
    and status = 'active';
  if found then
    return jsonb_build_object('outcome', 'already_enrolled', 'enrollmentId', v_existing.id);
  end if;

  select greatest(max(completed_at), max(stopped_at)) into v_last_ended
  from public.voom_email_flow_enrollments
  where owner_user_id = p_owner_user_id
    and flow_id = p_flow_id
    and contact_id = p_contact_id;

  if v_last_ended is not null then
    if v_flow.reentry_policy = 'once_per_contact' then
      -- Welcome: one enrollment per contact per flow, ever.
      return jsonb_build_object('outcome', 'already_enrolled', 'reason', 'once_per_contact');
    end if;
    if v_last_ended + make_interval(days => v_flow.cooldown_days) > now() then
      return jsonb_build_object('outcome', 'cooldown', 'reason', 'reengagement_cooldown');
    end if;
  end if;

  select * into v_step
  from public.voom_email_flow_steps
  where owner_user_id = p_owner_user_id
    and flow_id = p_flow_id
    and revision = v_flow.current_revision
    and position = 0;
  if not found then
    return jsonb_build_object('outcome', 'flow_inactive', 'reason', 'flow_has_no_steps');
  end if;

  insert into public.voom_email_flow_enrollments (
    owner_user_id, flow_id, contact_id, revision, status,
    current_position, next_eligible_at
  ) values (
    p_owner_user_id, p_flow_id, p_contact_id, v_flow.current_revision, 'active',
    0, p_scheduled_for
  )
  returning * into v_enrollment;

  insert into public.voom_email_flow_step_runs (
    owner_user_id, flow_id, enrollment_id, step_id, revision, position,
    status, idempotency_key, scheduled_for
  ) values (
    p_owner_user_id, p_flow_id, v_enrollment.id, v_step.id, v_enrollment.revision, 0,
    'scheduled', p_idempotency_key, p_scheduled_for
  );

  insert into public.voom_email_flow_events (owner_user_id, flow_id, enrollment_id, kind, detail)
  values (p_owner_user_id, p_flow_id, v_enrollment.id, 'contact_enrolled', jsonb_build_object(
    'position', 0,
    'scheduledFor', p_scheduled_for
  ));

  return jsonb_build_object('outcome', 'enrolled', 'enrollmentId', v_enrollment.id);
end;
$$;

-- 3. Claim a due step run for sending. Idempotent and double-send proof.
--
-- The caller owns the send only when the returned idempotency_key equals the
-- key it passed. Anything else means another worker already claimed it, it is
-- already in flight, or it already completed — in every case: do not send.
create or replace function public.claim_email_flow_step_run(
  p_owner_user_id uuid,
  p_run_id uuid,
  p_attempt_key text,
  p_lease_minutes integer default 10
) returns public.voom_email_flow_step_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.voom_email_flow_step_runs;
  v_flow public.voom_email_flows;
  v_enrollment public.voom_email_flow_enrollments;
  v_step public.voom_email_flow_steps;
  v_lease interval := make_interval(mins => greatest(1, coalesce(p_lease_minutes, 10)));
begin
  if coalesce(p_attempt_key, '') = '' or char_length(p_attempt_key) < 16 then
    raise exception 'invalid_idempotency_key';
  end if;

  select * into v_run
  from public.voom_email_flow_step_runs
  where id = p_run_id and owner_user_id = p_owner_user_id
  for update;
  if not found then
    raise exception 'step_run_not_found';
  end if;

  -- Terminal or in-flight: hand the existing row back untouched.
  if v_run.status in ('accepted', 'delivered', 'skipped') then
    return v_run;
  end if;
  if v_run.status = 'failed' and v_run.attempts >= 3 then
    return v_run;
  end if;
  if v_run.status = 'sending' and v_run.claimed_at is not null
     and v_run.claimed_at > now() - v_lease then
    return v_run;
  end if;

  select * into v_flow
  from public.voom_email_flows
  where id = v_run.flow_id and owner_user_id = p_owner_user_id
  for update;
  if not found or v_flow.status <> 'active' then
    raise exception 'flow_not_active';
  end if;

  select * into v_enrollment
  from public.voom_email_flow_enrollments
  where id = v_run.enrollment_id and owner_user_id = p_owner_user_id
  for update;
  if not found or v_enrollment.status <> 'active' then
    raise exception 'enrollment_not_active';
  end if;

  if v_run.attempts >= 3 then
    -- Bounded retry: never infinite-loop a failing step.
    update public.voom_email_flow_step_runs
    set status = 'failed',
        last_error_code = 'retry_limit_reached',
        last_error_message = 'Voom stopped retrying this step after three attempts.'
    where id = v_run.id and owner_user_id = p_owner_user_id
    returning * into v_run;

    update public.voom_email_flow_enrollments
    set status = 'stopped', stop_reason = 'send_failed', stopped_at = now()
    where id = v_enrollment.id and owner_user_id = p_owner_user_id and status = 'active';

    insert into public.voom_email_flow_events (owner_user_id, flow_id, enrollment_id, kind, detail)
    values (p_owner_user_id, v_run.flow_id, v_run.enrollment_id, 'send_failed',
            jsonb_build_object('position', v_run.position, 'reason', 'retry_limit_reached'));
    return v_run;
  end if;

  -- Freeze exactly what will be sent, from the revision this contact pinned.
  select * into v_step
  from public.voom_email_flow_steps
  where owner_user_id = p_owner_user_id
    and flow_id = v_run.flow_id
    and revision = v_run.revision
    and position = v_run.position;
  if not found then
    raise exception 'flow_step_missing';
  end if;

  update public.voom_email_flow_step_runs
  set status = 'sending',
      attempts = attempts + 1,
      claimed_at = now(),
      idempotency_key = p_attempt_key,
      step_id = v_step.id,
      last_error_code = null,
      last_error_message = null,
      content_snapshot = jsonb_build_object(
        'subject', v_step.subject,
        'previewText', v_step.preview_text,
        'body', v_step.body,
        'cta', v_step.cta,
        'ctaUrl', v_step.cta_url,
        'revision', v_step.revision
      )
  where id = v_run.id and owner_user_id = p_owner_user_id
  returning * into v_run;

  return v_run;
end;
$$;

-- 4. Record the provider's answer. Acceptance is never delivery.
create or replace function public.record_email_flow_step_provider_result(
  p_owner_user_id uuid,
  p_run_id uuid,
  p_outcome text,
  p_provider_status text default null,
  p_provider_message_id text default null,
  p_error_code text default null,
  p_error_message text default null
) returns public.voom_email_flow_step_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_outcome text := lower(trim(coalesce(p_outcome, '')));
  v_provider_status text := nullif(trim(coalesce(p_provider_status, '')), '');
  v_provider_message_id text := nullif(trim(coalesce(p_provider_message_id, '')), '');
  v_error_code text := nullif(trim(coalesce(p_error_code, '')), '');
  v_error_message text := nullif(trim(coalesce(p_error_message, '')), '');
  v_run public.voom_email_flow_step_runs;
begin
  if v_outcome not in ('accepted', 'failed') then
    raise exception 'invalid_provider_outcome';
  end if;
  if v_provider_message_id is not null and char_length(v_provider_message_id) > 200 then
    raise exception 'invalid_provider_message_id';
  end if;

  select * into v_run
  from public.voom_email_flow_step_runs
  where id = p_run_id and owner_user_id = p_owner_user_id
  for update;
  if not found then
    raise exception 'step_run_not_found';
  end if;
  -- A verified delivery is final; a late provider answer cannot downgrade it.
  if v_run.status = 'delivered' then
    return v_run;
  end if;

  if v_outcome = 'accepted' then
    if v_provider_message_id is null then
      raise exception 'provider_message_id_required';
    end if;

    update public.voom_email_flow_step_runs
    set provider_message_id = v_provider_message_id,
        provider_status = coalesce(v_provider_status, 'accepted'),
        status = 'accepted',
        accepted_at = coalesce(accepted_at, now()),
        last_error_code = null,
        last_error_message = null
    where id = p_run_id and owner_user_id = p_owner_user_id
    returning * into v_run;

    insert into public.voom_email_flow_events (owner_user_id, flow_id, enrollment_id, kind, detail)
    values (p_owner_user_id, v_run.flow_id, v_run.enrollment_id, 'provider_accepted',
            jsonb_build_object('position', v_run.position, 'provider', 'resend'));

    update public.voom_email_flow_enrollments
    set last_step_at = now()
    where id = v_run.enrollment_id and owner_user_id = p_owner_user_id and status = 'active';
  else
    update public.voom_email_flow_step_runs
    set provider_message_id = coalesce(provider_message_id, v_provider_message_id),
        provider_status = coalesce(v_provider_status, provider_status, 'failed'),
        status = 'failed',
        last_error_code = v_error_code,
        last_error_message = v_error_message
    where id = p_run_id and owner_user_id = p_owner_user_id
    returning * into v_run;

    insert into public.voom_email_flow_events (owner_user_id, flow_id, enrollment_id, kind, detail)
    values (p_owner_user_id, v_run.flow_id, v_run.enrollment_id, 'send_failed',
            jsonb_build_object('position', v_run.position, 'code', v_error_code));

    -- Bounded retry, enforced here as well as in the claim writer. Once the
    -- attempt budget is spent the enrollment STOPS instead of hanging in
    -- 'active' behind a dead step: it is then a real "needs attention" fact
    -- rather than an invisible one. Nothing already sent is rewritten.
    if v_run.attempts >= 3 then
      update public.voom_email_flow_enrollments
      set status = 'stopped', stop_reason = 'send_failed', stopped_at = now()
      where id = v_run.enrollment_id and owner_user_id = p_owner_user_id and status = 'active';

      update public.voom_email_flow_step_runs
      set status = 'skipped'
      where owner_user_id = p_owner_user_id
        and enrollment_id = v_run.enrollment_id
        and status = 'scheduled';

      insert into public.voom_email_flow_events (owner_user_id, flow_id, enrollment_id, kind, detail)
      values (p_owner_user_id, v_run.flow_id, v_run.enrollment_id, 'enrollment_stopped',
              jsonb_build_object('position', v_run.position, 'reason', 'send_failed'));
    end if;
  end if;

  return v_run;
end;
$$;

-- 5. Record a verified provider delivery event (the ONLY path to 'delivered').
create or replace function public.record_email_flow_delivery_event(
  p_owner_user_id uuid,
  p_send_id uuid,
  p_provider text,
  p_event_id text,
  p_event_type text,
  p_received_at timestamptz default now(),
  p_provider_status text default null
) returns public.voom_email_flow_step_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider text := lower(trim(coalesce(p_provider, '')));
  v_event_id text := trim(coalesce(p_event_id, ''));
  v_event_type text := trim(coalesce(p_event_type, ''));
  v_provider_status text := nullif(trim(coalesce(p_provider_status, '')), '');
  v_normalized text;
  v_inserted uuid;
  v_run public.voom_email_flow_step_runs;
  v_email text;
begin
  if v_provider <> 'resend' then
    raise exception 'invalid_event_provider';
  end if;
  if char_length(v_event_id) < 1 or char_length(v_event_id) > 200 then
    raise exception 'invalid_event_id';
  end if;
  if char_length(v_event_type) < 1 or char_length(v_event_type) > 120 then
    raise exception 'invalid_event_type';
  end if;

  select * into v_run
  from public.voom_email_flow_step_runs
  where id = p_send_id and owner_user_id = p_owner_user_id
  for update;
  if not found then
    raise exception 'step_run_not_found';
  end if;

  insert into public.voom_email_flow_delivery_events (
    owner_user_id, send_id, provider, event_id, event_type, received_at
  ) values (
    p_owner_user_id, p_send_id, v_provider, v_event_id, v_event_type, coalesce(p_received_at, now())
  )
  on conflict (owner_user_id, provider, event_id) do nothing
  returning id into v_inserted;

  -- A replayed provider event changes nothing.
  if v_inserted is null then
    return v_run;
  end if;

  v_normalized := lower(coalesce(v_provider_status, v_event_type));

  if v_normalized in ('email.delivered', 'delivered') then
    update public.voom_email_flow_step_runs
    set provider_status = coalesce(v_provider_status, v_event_type),
        status = 'delivered',
        accepted_at = coalesce(accepted_at, p_received_at, now()),
        delivered_at = coalesce(delivered_at, p_received_at, now()),
        last_error_code = null,
        last_error_message = null
    where id = p_send_id and owner_user_id = p_owner_user_id
    returning * into v_run;

    insert into public.voom_email_flow_events (owner_user_id, flow_id, enrollment_id, kind, detail)
    values (p_owner_user_id, v_run.flow_id, v_run.enrollment_id, 'delivered',
            jsonb_build_object('position', v_run.position));

  elsif v_normalized in (
    'email.bounced', 'email.complained', 'email.failed', 'email.canceled',
    'bounced', 'complained', 'failed', 'canceled', 'undelivered'
  ) then
    if v_run.status <> 'delivered' then
      update public.voom_email_flow_step_runs
      set provider_status = coalesce(v_provider_status, v_event_type),
          status = 'failed',
          last_error_code = left(v_normalized, 120),
          last_error_message = 'The provider reported that delivery failed.'
      where id = p_send_id and owner_user_id = p_owner_user_id
      returning * into v_run;
    end if;

    -- Durable suppression: a bounced or complained address must never be
    -- emailed again by any flow, and the enrollment stops here.
    if v_normalized in ('email.bounced', 'email.complained', 'bounced', 'complained') then
      select c.email into v_email
      from public.voom_email_flow_enrollments e
      join public.contacts c on c.id = e.contact_id and c.owner_id = e.owner_user_id
      where e.id = v_run.enrollment_id and e.owner_user_id = p_owner_user_id;

      if v_email is not null then
        insert into public.voom_email_suppressions (owner_id, email, reason, provider, provider_event_id, detail)
        values (
          p_owner_user_id, v_email,
          case when v_normalized in ('email.complained', 'complained') then 'complained' else 'bounced' end,
          'resend', v_event_id, 'Recorded from a verified Resend delivery event.'
        )
        on conflict (owner_id, email, reason) do nothing;
      end if;

      update public.voom_email_flow_enrollments
      set status = 'stopped',
          stop_reason = case when v_normalized in ('email.complained', 'complained')
                             then 'complained' else 'bounced' end,
          stopped_at = now()
      where id = v_run.enrollment_id and owner_user_id = p_owner_user_id and status = 'active';

      update public.voom_email_flow_step_runs
      set status = 'skipped'
      where owner_user_id = p_owner_user_id
        and enrollment_id = v_run.enrollment_id
        and status = 'scheduled';
    end if;

    insert into public.voom_email_flow_events (owner_user_id, flow_id, enrollment_id, kind, detail)
    values (p_owner_user_id, v_run.flow_id, v_run.enrollment_id, 'send_failed',
            jsonb_build_object('position', v_run.position, 'event', v_normalized));

  elsif v_run.status = 'sending' then
    update public.voom_email_flow_step_runs
    set provider_status = coalesce(v_provider_status, v_event_type),
        status = 'accepted',
        accepted_at = coalesce(accepted_at, p_received_at, now())
    where id = p_send_id and owner_user_id = p_owner_user_id
    returning * into v_run;
  else
    update public.voom_email_flow_step_runs
    set provider_status = coalesce(v_provider_status, v_event_type)
    where id = p_send_id and owner_user_id = p_owner_user_id
    returning * into v_run;
  end if;

  return v_run;
end;
$$;

-- 6. Move an enrollment to its next step, or complete it.
--
-- Idempotent on (enrollment, position): replaying the same advance after a
-- crash returns the stored state and never creates a second run for a step.
create or replace function public.advance_email_flow_enrollment(
  p_owner_user_id uuid,
  p_enrollment_id uuid,
  p_completed_position integer,
  p_next_scheduled_for timestamptz default null,
  p_next_idempotency_key text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_enrollment public.voom_email_flow_enrollments;
  v_next public.voom_email_flow_steps;
  v_run_id uuid;
begin
  select * into v_enrollment
  from public.voom_email_flow_enrollments
  where id = p_enrollment_id and owner_user_id = p_owner_user_id
  for update;
  if not found then
    raise exception 'enrollment_not_found';
  end if;

  if v_enrollment.status <> 'active' then
    return jsonb_build_object('outcome', 'noop', 'status', v_enrollment.status);
  end if;
  -- A replayed or out-of-order advance changes nothing.
  if v_enrollment.current_position <> p_completed_position then
    return jsonb_build_object('outcome', 'noop', 'position', v_enrollment.current_position);
  end if;

  select * into v_next
  from public.voom_email_flow_steps
  where owner_user_id = p_owner_user_id
    and flow_id = v_enrollment.flow_id
    and revision = v_enrollment.revision
    and position = p_completed_position + 1;

  if not found then
    update public.voom_email_flow_enrollments
    set status = 'completed', completed_at = now(), next_eligible_at = null,
        last_step_at = now()
    where id = p_enrollment_id and owner_user_id = p_owner_user_id
    returning * into v_enrollment;

    insert into public.voom_email_flow_events (owner_user_id, flow_id, enrollment_id, kind, detail)
    values (p_owner_user_id, v_enrollment.flow_id, p_enrollment_id, 'enrollment_completed',
            jsonb_build_object('steps', p_completed_position + 1));

    return jsonb_build_object('outcome', 'completed', 'steps', p_completed_position + 1);
  end if;

  if p_next_scheduled_for is null or p_next_scheduled_for <= now() then
    raise exception 'invalid_schedule';
  end if;
  if coalesce(p_next_idempotency_key, '') = '' or char_length(p_next_idempotency_key) < 16 then
    raise exception 'invalid_idempotency_key';
  end if;

  update public.voom_email_flow_enrollments
  set current_position = p_completed_position + 1,
      next_eligible_at = p_next_scheduled_for,
      last_step_at = now()
  where id = p_enrollment_id and owner_user_id = p_owner_user_id
  returning * into v_enrollment;

  insert into public.voom_email_flow_step_runs (
    owner_user_id, flow_id, enrollment_id, step_id, revision, position,
    status, idempotency_key, scheduled_for
  ) values (
    p_owner_user_id, v_enrollment.flow_id, p_enrollment_id, v_next.id, v_enrollment.revision,
    p_completed_position + 1, 'scheduled', p_next_idempotency_key, p_next_scheduled_for
  )
  on conflict (owner_user_id, enrollment_id, position) do nothing
  returning id into v_run_id;

  if v_run_id is not null then
    insert into public.voom_email_flow_events (owner_user_id, flow_id, enrollment_id, kind, detail)
    values (p_owner_user_id, v_enrollment.flow_id, p_enrollment_id, 'step_scheduled',
            jsonb_build_object('position', p_completed_position + 1, 'scheduledFor', p_next_scheduled_for));
  end if;

  return jsonb_build_object(
    'outcome', 'advanced',
    'position', p_completed_position + 1,
    'scheduledFor', p_next_scheduled_for
  );
end;
$$;

-- 7. Stop an enrollment safely. Pending runs are skipped; anything already
--    accepted or delivered is left exactly as it is.
create or replace function public.stop_email_flow_enrollment(
  p_owner_user_id uuid,
  p_enrollment_id uuid,
  p_reason text,
  p_kind text default 'enrollment_stopped'
) returns public.voom_email_flow_enrollments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text := left(trim(coalesce(p_reason, '')), 120);
  v_kind text := lower(trim(coalesce(p_kind, 'enrollment_stopped')));
  v_enrollment public.voom_email_flow_enrollments;
  v_skipped integer;
begin
  if v_reason = '' then
    raise exception 'invalid_stop_reason';
  end if;
  if v_kind not in ('enrollment_stopped', 'send_skipped') then
    raise exception 'invalid_event_kind';
  end if;

  select * into v_enrollment
  from public.voom_email_flow_enrollments
  where id = p_enrollment_id and owner_user_id = p_owner_user_id
  for update;
  if not found then
    raise exception 'enrollment_not_found';
  end if;
  if v_enrollment.status <> 'active' then
    return v_enrollment;
  end if;

  update public.voom_email_flow_enrollments
  set status = 'stopped', stop_reason = v_reason, stopped_at = now(), next_eligible_at = null
  where id = p_enrollment_id and owner_user_id = p_owner_user_id
  returning * into v_enrollment;

  update public.voom_email_flow_step_runs
  set status = 'skipped', last_error_code = v_reason
  where owner_user_id = p_owner_user_id
    and enrollment_id = p_enrollment_id
    and status in ('scheduled', 'sending', 'failed');

  get diagnostics v_skipped = row_count;

  insert into public.voom_email_flow_events (owner_user_id, flow_id, enrollment_id, kind, detail)
  values (p_owner_user_id, v_enrollment.flow_id, p_enrollment_id, v_kind,
          jsonb_build_object('reason', v_reason, 'pendingSkipped', coalesce(v_skipped, 0)));

  return v_enrollment;
end;
$$;

-- 8. Flow lifecycle: activate / pause / resume / archive.
--
-- Activation is only ever recorded as an explicit owner action. There is no
-- argument that lets a caller claim an automatic activation, so Autopilot
-- cannot authorize itself: a proposed flow stays a draft until the owner acts.
create or replace function public.set_email_flow_status(
  p_owner_user_id uuid,
  p_flow_id uuid,
  p_status text
) returns public.voom_email_flows
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text := lower(trim(coalesce(p_status, '')));
  v_flow public.voom_email_flows;
  v_previous text;
  v_event text;
begin
  if v_status not in ('draft', 'active', 'paused', 'archived') then
    raise exception 'invalid_flow_status';
  end if;

  select * into v_flow
  from public.voom_email_flows
  where id = p_flow_id and owner_user_id = p_owner_user_id
  for update;
  if not found then
    raise exception 'flow_not_found';
  end if;
  -- Captured BEFORE the update: the transition label depends on where the
  -- flow was, and the updated row no longer carries it.
  v_previous := v_flow.status;
  if v_flow.status = 'archived' then
    raise exception 'flow_archived';
  end if;
  if v_flow.status = v_status then
    return v_flow;
  end if;
  if v_status = 'draft' then
    -- A flow can never go back to draft: that would hide an activation that
    -- already happened and make the lifecycle ambiguous.
    raise exception 'cannot_revert_to_draft';
  end if;

  if v_status = 'active' then
    update public.voom_email_flows
    set status = 'active',
        activated_at = coalesce(activated_at, now()),
        activated_by = 'user',
        paused_at = null
    where id = p_flow_id and owner_user_id = p_owner_user_id
    returning * into v_flow;
    v_event := case when v_previous = 'paused' then 'flow_resumed' else 'flow_activated' end;
  elsif v_status = 'paused' then
    update public.voom_email_flows
    set status = 'paused', paused_at = now()
    where id = p_flow_id and owner_user_id = p_owner_user_id
    returning * into v_flow;
    v_event := 'flow_paused';
  else
    update public.voom_email_flows
    set status = 'archived', archived_at = now(), paused_at = null
    where id = p_flow_id and owner_user_id = p_owner_user_id
    returning * into v_flow;
    v_event := 'flow_archived';
  end if;

  insert into public.voom_email_flow_events (owner_user_id, flow_id, kind, detail)
  values (p_owner_user_id, p_flow_id, v_event,
          jsonb_build_object('from', v_previous, 'to', v_status));

  return v_flow;
end;
$$;

-- 9. Push a run FORWARD only. Two uses:
--      - resume / long outage: an overdue pile is spread into future windows
--        instead of being burst-sent;
--      - bounded retry: a run that FAILED with attempts still available goes
--        back to 'scheduled' with the SAME row, so `attempts` keeps counting
--        and the claim writer stops it for good at the retry ceiling.
--    Anything already accepted, delivered or skipped is history and is never
--    rewritten, and the instant can never move backwards.
create or replace function public.reschedule_email_flow_step_run(
  p_owner_user_id uuid,
  p_run_id uuid,
  p_new_scheduled_for timestamptz
) returns public.voom_email_flow_step_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.voom_email_flow_step_runs;
  v_retryable boolean;
begin
  if p_new_scheduled_for is null or p_new_scheduled_for <= now() then
    raise exception 'invalid_schedule';
  end if;

  select * into v_run
  from public.voom_email_flow_step_runs
  where id = p_run_id and owner_user_id = p_owner_user_id
  for update;
  if not found then
    raise exception 'step_run_not_found';
  end if;

  v_retryable := v_run.status = 'failed' and v_run.attempts < 3;
  if v_run.status <> 'scheduled' and not v_retryable then
    return v_run;
  end if;

  update public.voom_email_flow_step_runs
  set scheduled_for = greatest(scheduled_for, p_new_scheduled_for),
      status = 'scheduled',
      last_error_code = null,
      last_error_message = null
  where id = p_run_id and owner_user_id = p_owner_user_id
  returning * into v_run;

  update public.voom_email_flow_enrollments
  set next_eligible_at = greatest(coalesce(next_eligible_at, p_new_scheduled_for), p_new_scheduled_for)
  where id = v_run.enrollment_id
    and owner_user_id = p_owner_user_id
    and status = 'active';

  return v_run;
end;
$$;

-- 10. Edit a flow: writes a NEW revision for future enrollments. Existing
--     enrollments stay pinned to their revision, step runs keep their content
--     snapshot, and nothing already sent is touched.
create or replace function public.revise_email_flow(
  p_owner_user_id uuid,
  p_flow_id uuid,
  p_patch jsonb,
  p_steps jsonb
) returns public.voom_email_flows
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_flow public.voom_email_flows;
  v_steps jsonb := coalesce(p_steps, '[]'::jsonb);
  v_step jsonb;
  v_position integer;
  v_count integer;
  v_next_revision integer;
begin
  select * into v_flow
  from public.voom_email_flows
  where id = p_flow_id and owner_user_id = p_owner_user_id
  for update;
  if not found then
    raise exception 'flow_not_found';
  end if;
  if v_flow.status = 'archived' then
    raise exception 'flow_archived';
  end if;
  if v_flow.current_revision >= 1000 then
    raise exception 'revision_limit_reached';
  end if;
  if jsonb_typeof(v_steps) <> 'array' or jsonb_array_length(v_steps) < 1 then
    raise exception 'flow_requires_steps';
  end if;
  if jsonb_array_length(v_steps) > 12 then
    raise exception 'too_many_flow_steps';
  end if;

  v_next_revision := v_flow.current_revision + 1;
  v_position := 0;
  for v_step in select * from jsonb_array_elements(v_steps)
  loop
    if char_length(coalesce(v_step ->> 'subject', '')) not between 1 and 300 then
      raise exception 'invalid_step_subject';
    end if;
    if char_length(coalesce(v_step ->> 'body', '')) not between 1 and 12000 then
      raise exception 'invalid_step_body';
    end if;
    if coalesce((v_step ->> 'waitMinutes')::integer, 0) not between 0 and 20160 then
      raise exception 'invalid_step_wait';
    end if;

    insert into public.voom_email_flow_steps (
      owner_user_id, flow_id, revision, position, step_type,
      title, purpose, wait_minutes, subject, preview_text, body, cta, cta_url, content_source
    ) values (
      p_owner_user_id, p_flow_id, v_next_revision, v_position, 'email',
      left(trim(coalesce(v_step ->> 'title', v_step ->> 'subject', '')), 160),
      left(trim(coalesce(v_step ->> 'purpose', '')), 1000),
      greatest(0, coalesce((v_step ->> 'waitMinutes')::integer, 0)),
      left(trim(v_step ->> 'subject'), 300),
      left(trim(coalesce(v_step ->> 'previewText', '')), 500),
      v_step ->> 'body',
      left(trim(coalesce(v_step ->> 'cta', '')), 160),
      nullif(trim(coalesce(v_step ->> 'ctaUrl', '')), ''),
      'edited'
    );
    v_position := v_position + 1;
  end loop;

  select count(*) into v_count
  from public.voom_email_flow_steps
  where owner_user_id = p_owner_user_id and flow_id = p_flow_id and revision = v_next_revision;
  if v_count <> jsonb_array_length(v_steps) then
    raise exception 'flow_steps_not_persisted';
  end if;

  update public.voom_email_flows
  set current_revision = v_next_revision,
      name = coalesce(nullif(trim(coalesce(p_patch ->> 'name', '')), ''), name),
      objective = coalesce(nullif(trim(coalesce(p_patch ->> 'objective', '')), ''), objective),
      generation_source = case
        when lower(coalesce(p_patch ->> 'generationSource', '')) = 'mara' then 'mara'
        else generation_source
      end,
      strategy = coalesce(p_patch -> 'strategy', strategy),
      strategy_summary = coalesce(nullif(trim(coalesce(p_patch ->> 'strategySummary', '')), ''), strategy_summary)
  where id = p_flow_id and owner_user_id = p_owner_user_id
  returning * into v_flow;

  insert into public.voom_email_flow_events (owner_user_id, flow_id, kind, detail)
  values (p_owner_user_id, p_flow_id, 'flow_revised', jsonb_build_object(
    'revision', v_next_revision,
    'steps', jsonb_array_length(v_steps)
  ));

  return v_flow;
end;
$$;

-- 11. Record a provider suppression for an address (used by the shared Resend
--     webhook for campaign sends too, so one bounce stops every future send).
create or replace function public.record_email_suppression(
  p_owner_user_id uuid,
  p_email text,
  p_reason text,
  p_provider text default 'resend',
  p_provider_event_id text default null,
  p_detail text default null
) returns public.voom_email_suppressions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_reason text := lower(trim(coalesce(p_reason, '')));
  v_row public.voom_email_suppressions;
begin
  if v_reason not in ('bounced', 'complained', 'failed', 'manual') then
    raise exception 'invalid_suppression_reason';
  end if;
  if v_email !~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$' or char_length(v_email) > 320 then
    raise exception 'invalid_email';
  end if;

  insert into public.voom_email_suppressions (
    owner_id, email, reason, provider, provider_event_id, detail
  ) values (
    p_owner_user_id, v_email, v_reason,
    nullif(lower(trim(coalesce(p_provider, ''))), ''),
    nullif(trim(coalesce(p_provider_event_id, '')), ''),
    nullif(trim(coalesce(p_detail, '')), '')
  )
  on conflict (owner_id, email, reason) do update
    set provider_event_id = coalesce(excluded.provider_event_id, public.voom_email_suppressions.provider_event_id)
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.create_email_flow(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.enroll_email_flow_contact(uuid, uuid, uuid, timestamptz, text) from public, anon, authenticated;
revoke all on function public.claim_email_flow_step_run(uuid, uuid, text, integer) from public, anon, authenticated;
revoke all on function public.record_email_flow_step_provider_result(uuid, uuid, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.record_email_flow_delivery_event(uuid, uuid, text, text, text, timestamptz, text) from public, anon, authenticated;
revoke all on function public.advance_email_flow_enrollment(uuid, uuid, integer, timestamptz, text) from public, anon, authenticated;
revoke all on function public.stop_email_flow_enrollment(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.set_email_flow_status(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.reschedule_email_flow_step_run(uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.revise_email_flow(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.record_email_suppression(uuid, text, text, text, text, text) from public, anon, authenticated;

grant execute on function public.create_email_flow(uuid, jsonb) to service_role;
grant execute on function public.enroll_email_flow_contact(uuid, uuid, uuid, timestamptz, text) to service_role;
grant execute on function public.claim_email_flow_step_run(uuid, uuid, text, integer) to service_role;
grant execute on function public.record_email_flow_step_provider_result(uuid, uuid, text, text, text, text, text) to service_role;
grant execute on function public.record_email_flow_delivery_event(uuid, uuid, text, text, text, timestamptz, text) to service_role;
grant execute on function public.advance_email_flow_enrollment(uuid, uuid, integer, timestamptz, text) to service_role;
grant execute on function public.stop_email_flow_enrollment(uuid, uuid, text, text) to service_role;
grant execute on function public.set_email_flow_status(uuid, uuid, text) to service_role;
grant execute on function public.reschedule_email_flow_step_run(uuid, uuid, timestamptz) to service_role;
grant execute on function public.revise_email_flow(uuid, uuid, jsonb, jsonb) to service_role;
grant execute on function public.record_email_suppression(uuid, text, text, text, text, text) to service_role;

commit;
