-- Canonical Voom calendar/campaign records plus MARA tool audit and confirmation queue.
-- Safe to re-run. All access is owner-scoped through RLS.

begin;

create table if not exists public.content_calendar_items (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 160),
  channel text not null check (channel in ('Instagram', 'Reel', 'Feed', 'Email', 'SMS')),
  content text not null default '' check (char_length(content) <= 12000),
  topic text not null default '' check (char_length(topic) <= 500),
  publish_at timestamptz not null,
  status text not null default 'proposed' check (status in ('proposed', 'draft', 'approved', 'scheduled')),
  source_draft_id uuid references public.mara_drafts (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_user_id)
);

create table if not exists public.voom_campaigns (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('email', 'sms')),
  name text not null check (char_length(name) between 1 and 160),
  objective text not null default '' check (char_length(objective) <= 1000),
  audience text not null default '' check (char_length(audience) <= 1000),
  subject text check (subject is null or char_length(subject) <= 300),
  preview_text text check (preview_text is null or char_length(preview_text) <= 500),
  content text not null default '' check (char_length(content) <= 12000),
  proposed_send_at timestamptz,
  status text not null default 'draft' check (status in ('draft', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_user_id)
);

create table if not exists public.mara_pending_actions (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid not null,
  message_id uuid references public.mara_messages (id) on delete set null,
  tool_name text not null check (char_length(tool_name) between 1 and 80),
  sanitized_arguments jsonb not null default '{}'::jsonb,
  summary text not null check (char_length(summary) between 1 and 1000),
  old_value jsonb,
  new_value jsonb,
  status text not null default 'pending' check (status in ('pending', 'executing', 'confirmed', 'cancelled', 'failed')),
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 200),
  result_summary text check (result_summary is null or char_length(result_summary) <= 1000),
  error_summary text check (error_summary is null or char_length(error_summary) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  executed_at timestamptz,
  unique (owner_user_id, idempotency_key),
  foreign key (conversation_id, owner_user_id)
    references public.mara_conversations (id, owner_user_id) on delete cascade
);

create table if not exists public.mara_tool_runs (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid not null,
  message_id uuid references public.mara_messages (id) on delete set null,
  pending_action_id uuid references public.mara_pending_actions (id) on delete set null,
  tool_name text not null check (char_length(tool_name) between 1 and 80),
  sanitized_arguments jsonb not null default '{}'::jsonb,
  status text not null check (status in ('started', 'succeeded', 'pending_confirmation', 'failed', 'rejected')),
  idempotency_key text check (idempotency_key is null or char_length(idempotency_key) between 16 and 200),
  result_summary text check (result_summary is null or char_length(result_summary) <= 1000),
  error_summary text check (error_summary is null or char_length(error_summary) <= 1000),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  foreign key (conversation_id, owner_user_id)
    references public.mara_conversations (id, owner_user_id) on delete cascade
);

create unique index if not exists mara_tool_runs_idempotency_idx
  on public.mara_tool_runs (owner_user_id, idempotency_key) where idempotency_key is not null;
create index if not exists calendar_owner_publish_idx on public.content_calendar_items (owner_user_id, publish_at);
create index if not exists campaigns_owner_updated_idx on public.voom_campaigns (owner_user_id, updated_at desc);
create index if not exists pending_owner_created_idx on public.mara_pending_actions (owner_user_id, created_at);
create index if not exists tool_runs_owner_started_idx on public.mara_tool_runs (owner_user_id, started_at desc);

drop trigger if exists set_content_calendar_items_updated_at on public.content_calendar_items;
create trigger set_content_calendar_items_updated_at before update on public.content_calendar_items
  for each row execute function public.set_updated_at();
drop trigger if exists set_voom_campaigns_updated_at on public.voom_campaigns;
create trigger set_voom_campaigns_updated_at before update on public.voom_campaigns
  for each row execute function public.set_updated_at();
drop trigger if exists set_mara_pending_actions_updated_at on public.mara_pending_actions;
create trigger set_mara_pending_actions_updated_at before update on public.mara_pending_actions
  for each row execute function public.set_updated_at();

alter table public.content_calendar_items enable row level security;
alter table public.voom_campaigns enable row level security;
alter table public.mara_pending_actions enable row level security;
alter table public.mara_tool_runs enable row level security;

revoke all on table public.content_calendar_items, public.voom_campaigns, public.mara_pending_actions, public.mara_tool_runs from anon, authenticated;
grant select, insert, update, delete on table public.content_calendar_items to authenticated;
grant select, insert, update on table public.voom_campaigns to authenticated;
grant select, insert, update on table public.mara_pending_actions to authenticated;
grant select, insert, update on table public.mara_tool_runs to authenticated;

drop policy if exists "calendar_items_own" on public.content_calendar_items;
create policy "calendar_items_own" on public.content_calendar_items for all to authenticated
  using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
drop policy if exists "voom_campaigns_own" on public.voom_campaigns;
create policy "voom_campaigns_own" on public.voom_campaigns for all to authenticated
  using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
drop policy if exists "mara_pending_actions_own" on public.mara_pending_actions;
create policy "mara_pending_actions_own" on public.mara_pending_actions for all to authenticated
  using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);
drop policy if exists "mara_tool_runs_select_own" on public.mara_tool_runs;
create policy "mara_tool_runs_select_own" on public.mara_tool_runs for select to authenticated
  using ((select auth.uid()) = owner_user_id);
drop policy if exists "mara_tool_runs_insert_own" on public.mara_tool_runs;
create policy "mara_tool_runs_insert_own" on public.mara_tool_runs for insert to authenticated
  with check ((select auth.uid()) = owner_user_id);
drop policy if exists "mara_tool_runs_update_own" on public.mara_tool_runs;
create policy "mara_tool_runs_update_own" on public.mara_tool_runs for update to authenticated
  using ((select auth.uid()) = owner_user_id) with check ((select auth.uid()) = owner_user_id);

commit;
