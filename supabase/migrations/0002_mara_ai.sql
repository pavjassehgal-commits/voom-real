-- MARA conversations, messages, and generated content drafts.
-- Safe to re-run. Users may only access rows carrying their own auth.uid().

create table if not exists public.mara_conversations (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  title text not null default 'New conversation' check (char_length(title) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_user_id)
);

create table if not exists public.mara_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) between 1 and 12000),
  created_at timestamptz not null default now(),
  foreign key (conversation_id, owner_user_id)
    references public.mara_conversations (id, owner_user_id) on delete cascade
);

create table if not exists public.mara_drafts (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  message_id uuid,
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('instagram_caption', 'reel', 'email', 'sms', 'campaign_plan', 'weekly_calendar')),
  channel text not null check (char_length(channel) between 1 and 60),
  title text not null check (char_length(title) between 1 and 160),
  content text not null check (char_length(content) between 1 and 12000),
  proposed_publish_at timestamptz,
  status text not null default 'draft' check (status in ('draft', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (conversation_id, owner_user_id)
    references public.mara_conversations (id, owner_user_id) on delete cascade,
  foreign key (message_id) references public.mara_messages (id) on delete set null
);

create index if not exists mara_conversations_owner_updated_idx
  on public.mara_conversations (owner_user_id, updated_at desc);
create index if not exists mara_messages_conversation_created_idx
  on public.mara_messages (conversation_id, created_at);
create index if not exists mara_messages_owner_rate_idx
  on public.mara_messages (owner_user_id, created_at desc) where role = 'user';
create index if not exists mara_drafts_owner_created_idx
  on public.mara_drafts (owner_user_id, created_at desc);

drop trigger if exists set_mara_conversations_updated_at on public.mara_conversations;
create trigger set_mara_conversations_updated_at
  before update on public.mara_conversations
  for each row execute function public.set_updated_at();

drop trigger if exists set_mara_drafts_updated_at on public.mara_drafts;
create trigger set_mara_drafts_updated_at
  before update on public.mara_drafts
  for each row execute function public.set_updated_at();

alter table public.mara_conversations enable row level security;
alter table public.mara_messages enable row level security;
alter table public.mara_drafts enable row level security;

revoke all on table public.mara_conversations, public.mara_messages, public.mara_drafts from anon;
revoke all on table public.mara_conversations, public.mara_messages, public.mara_drafts from authenticated;
grant select, insert, update, delete on table public.mara_conversations to authenticated;
grant select, insert on table public.mara_messages to authenticated;
grant select, insert, update on table public.mara_drafts to authenticated;

drop policy if exists "mara_conversations_own" on public.mara_conversations;
create policy "mara_conversations_own" on public.mara_conversations
  for all to authenticated
  using ((select auth.uid()) = owner_user_id)
  with check ((select auth.uid()) = owner_user_id);

drop policy if exists "mara_messages_select_own" on public.mara_messages;
create policy "mara_messages_select_own" on public.mara_messages
  for select to authenticated using ((select auth.uid()) = owner_user_id);
drop policy if exists "mara_messages_insert_own" on public.mara_messages;
create policy "mara_messages_insert_own" on public.mara_messages
  for insert to authenticated with check ((select auth.uid()) = owner_user_id);

drop policy if exists "mara_drafts_select_own" on public.mara_drafts;
create policy "mara_drafts_select_own" on public.mara_drafts
  for select to authenticated using ((select auth.uid()) = owner_user_id);
drop policy if exists "mara_drafts_insert_own" on public.mara_drafts;
create policy "mara_drafts_insert_own" on public.mara_drafts
  for insert to authenticated with check ((select auth.uid()) = owner_user_id);
drop policy if exists "mara_drafts_update_own" on public.mara_drafts;
create policy "mara_drafts_update_own" on public.mara_drafts
  for update to authenticated
  using ((select auth.uid()) = owner_user_id)
  with check ((select auth.uid()) = owner_user_id);
