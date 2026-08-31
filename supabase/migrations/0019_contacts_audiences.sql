-- Contacts + Audiences foundation.
-- Prepared for review; do NOT apply without explicit approval.

begin;

-- ─── contacts ──────────────────────────────────────────────────────────────

create table if not exists public.contacts (
  id           uuid        primary key default gen_random_uuid(),
  owner_id     uuid        not null references auth.users (id) on delete cascade,
  first_name   text        check (first_name is null or char_length(first_name) <= 200),
  last_name    text        check (last_name  is null or char_length(last_name)  <= 200),
  email        text        check (
                             email is null
                             or (email = lower(trim(email)) and char_length(email) <= 320)
                           ),
  phone        text        check (
                             phone is null
                             or (phone ~ '^\+[1-9][0-9]{7,14}$')
                           ),
  email_status text        not null default 'unknown'
               check (email_status in ('subscribed', 'unsubscribed', 'unknown')),
  sms_status   text        not null default 'unknown'
               check (sms_status in ('subscribed', 'unsubscribed', 'unknown')),
  tags         text[]      not null default '{}',
  source       text        not null default 'manual'
               check (source in ('manual', 'csv', 'import')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- at least one destination required
  constraint contacts_email_or_phone_required
    check (email is not null or phone is not null),

  -- subscribed status requires the corresponding destination to exist
  constraint contacts_subscribed_email_requires_email
    check (email_status <> 'subscribed' or email is not null),
  constraint contacts_subscribed_sms_requires_phone
    check (sms_status <> 'subscribed' or phone is not null),

  -- per-owner uniqueness; the same address is allowed for different owners
  constraint contacts_unique_email_per_owner
    unique (owner_id, email),
  constraint contacts_unique_phone_per_owner
    unique (owner_id, phone),

  -- composite unique required by audience_members FK before that table is created
  constraint contacts_id_owner_id_unique
    unique (id, owner_id)
);

create index if not exists contacts_owner_created_idx
  on public.contacts (owner_id, created_at desc);

create index if not exists contacts_tags_gin_idx
  on public.contacts using gin (tags);

-- RLS
alter table public.contacts enable row level security;

revoke all on table public.contacts from anon, authenticated;
grant select, insert, update, delete on table public.contacts to authenticated;
grant select, insert, update, delete on table public.contacts to service_role;

create policy "contacts_owner_all" on public.contacts
  for all
  to authenticated
  using  (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

-- ─── audiences ─────────────────────────────────────────────────────────────

create table if not exists public.audiences (
  id          uuid        primary key default gen_random_uuid(),
  owner_id    uuid        not null references auth.users (id) on delete cascade,
  name        text        not null check (char_length(name) between 1 and 200),
  description text        check (description is null or char_length(description) <= 2000),
  type        text        not null
              check (type in (
                'all_email_subscribers',
                'all_sms_subscribers',
                'tag',
                'manual'
              )),
  tag_filter  text        check (
                tag_filter is null
                or (type = 'tag' and char_length(tag_filter) between 1 and 200)
              ),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- tag audiences must have a tag_filter; others must not
  constraint audiences_tag_requires_filter
    check (type <> 'tag' or tag_filter is not null),
  constraint audiences_non_tag_no_filter
    check (type = 'tag' or tag_filter is null),

  -- composite unique required by audience_members FK before that table is created
  constraint audiences_id_owner_id_unique
    unique (id, owner_id)
);

create index if not exists audiences_owner_created_idx
  on public.audiences (owner_id, created_at desc);

-- RLS
alter table public.audiences enable row level security;

revoke all on table public.audiences from anon, authenticated;
grant select, insert, update, delete on table public.audiences to authenticated;
grant select, insert, update, delete on table public.audiences to service_role;

create policy "audiences_owner_all" on public.audiences
  for all
  to authenticated
  using  (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

-- ─── audience_members ──────────────────────────────────────────────────────

create table if not exists public.audience_members (
  audience_id uuid        not null,
  contact_id  uuid        not null,
  owner_id    uuid        not null references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now(),

  primary key (audience_id, contact_id),

  -- structurally prevent cross-owner membership
  foreign key (audience_id, owner_id)
    references public.audiences (id, owner_id) on delete cascade,
  foreign key (contact_id, owner_id)
    references public.contacts (id, owner_id) on delete cascade
);

create index if not exists audience_members_owner_audience_idx
  on public.audience_members (owner_id, audience_id, created_at desc);

create index if not exists audience_members_contact_idx
  on public.audience_members (contact_id);

-- RLS
alter table public.audience_members enable row level security;

revoke all on table public.audience_members from anon, authenticated;
grant select, insert, delete on table public.audience_members to authenticated;
grant select, insert, delete on table public.audience_members to service_role;

create policy "audience_members_owner_all" on public.audience_members
  for all
  to authenticated
  using  (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

commit;
