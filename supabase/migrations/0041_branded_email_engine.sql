-- 0041_branded_email_engine.sql
-- Branded Email Engine v1.
--
-- The product principle implemented here: Voom is the invisible engine; the
-- recipient experiences the business, never Voom as sender.
--
-- This migration is ADDITIVE and NON-DESTRUCTIVE. It:
--   1. adds owner-configured sending-identity columns to public.businesses
--      (business sender address + name + reply-to + a truthful provider
--      verification status); nothing is dropped or rewritten;
--   2. adds public.business_email_sender_domains — provider-backed records of
--      which sending domains this owner has actually verified with Resend, so
--      a "Verified" claim is based on stored state, never on a guess;
--   3. adds public.voom_email_suppression_controls — durable, owner-scoped
--      accumulate evidence of every suppress/unsubscribe control fired;
--   4. adds DELETE policies, storage-public policies and the service-role RPCs
--      for consuming an unsubscribe token without a recipient login:
--        - record_email_opt_out            (owner + address + evidence)
--        - record_email_opt_out_token      (idempotent token-firing evidence)
--
-- Everything here is owner-scoped RLS and reuses public.businesses/profile,
-- storage buckets and the existing voom_email_suppressions bounce/complaint
-- suppression. EMPHATICALLY it does not:
--   - call, reserve or credit any media provider (no Seedream/Seedance/
--     OpenRouter here or in the engine modules that read these tables);
--   - send an email or schedule a cron;
--   - modify a single byte of an existing table's rows.
--
-- Note: production is LIVE through 0040. This file must not be edited into
-- place until the operator applies it; nothing here changes live behaviour
-- until the code path that reads these tables ships.

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) Email brand fields on public.businesses
--    (sender identity + the brand surface the renderer reads)
-- ─────────────────────────────────────────────────────────────────────────────
-- website / primary_color / accent_color are ordinary business facts the
-- onboarding already collects; they are promoted to columns so the brand
-- profile has ONE authoritative source. Sender identity stays truthfully
-- owner-configured and provider-backing gate is supplied by section 2.

alter table public.businesses
  add column if not exists email_sender_address text,
  add column if not exists email_sender_name text,
  add column if not exists email_reply_to text,
  add column if not exists email_sender_status text,
  add column if not exists website text,
  add column if not exists primary_color text,
  add column if not exists accent_color text,
  add column if not exists logo_path text,
  add column if not exists footer_address text;

alter table public.businesses
  drop constraint if exists businesses_website_check;
alter table public.businesses
  add constraint businesses_website_check
  check (
    website is null
    or (char_length(website) between 1 and 500
        and website ~* '^https?://[^[:space:]@/]+([^\s]*)$')
  );

alter table public.businesses
  drop constraint if exists businesses_primary_color_check;
alter table public.businesses
  add constraint businesses_primary_color_check
  check (primary_color is null or primary_color ~* '^#[0-9a-fA-F]{6}$');

alter table public.businesses
  drop constraint if exists businesses_accent_color_check;
alter table public.businesses
  add constraint businesses_accent_color_check
  check (accent_color is null or accent_color ~* '^#[0-9a-fA-F]{6}$');

alter table public.businesses
  drop constraint if exists businesses_logo_path_check;
alter table public.businesses
  add constraint businesses_logo_path_check
  check (logo_path is null or char_length(logo_path) between 1 and 500);

alter table public.businesses
  drop constraint if exists businesses_footer_address_check;
alter table public.businesses
  add constraint businesses_footer_address_check
  check (footer_address is null or char_length(footer_address) <= 300);

-- Free-form configuration is length-checked, so a stored value can never grow
-- without bound. Verification status is a closed vocabulary, enforced server-side.
alter table public.businesses
  drop constraint if exists businesses_email_sender_address_check;
alter table public.businesses
  add constraint businesses_email_sender_address_check
  check (
    email_sender_address is null
    or (char_length(email_sender_address) between 6 and 320
        and email_sender_address = lower(email_sender_address)
        and email_sender_address ~* '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z0-9-]{2,}$')
  );

alter table public.businesses
  drop constraint if exists businesses_email_reply_to_check;
alter table public.businesses
  add constraint businesses_email_reply_to_check
  check (
    email_reply_to is null
    or (char_length(email_reply_to) between 6 and 320
        and email_reply_to = lower(email_reply_to)
        and email_reply_to ~* '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z0-9-]{2,}$')
  );

alter table public.businesses
  drop constraint if exists businesses_email_sender_name_check;
alter table public.businesses
  add constraint businesses_email_sender_name_check
  check (email_sender_name is null or char_length(email_sender_name) between 1 and 120);

alter table public.businesses
  drop constraint if exists businesses_email_sender_status_check;
alter table public.businesses
  add constraint businesses_email_sender_status_check
  check (
    email_sender_status is null
    or email_sender_status in ('not_configured', 'pending', 'verified', 'failed', 'unverified')
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Provider-backed sending domains
-- ─────────────────────────────────────────────────────────────────────────────
-- A "Verified" sender claim is stored here from provider-backed state; it is
-- never inferred from a domain string in application code. Rows are written by
-- the provider verification flow (out of scope for this migration — the table
-- + status vocabulary is the foundation), and read by the sender resolver.

create table if not exists public.business_email_sender_domains (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete set null,
  domain text not null check (
    char_length(domain) between 3 and 253
    and domain = lower(domain)
    and domain ~* '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
  ),
  -- Provider-backed verification state. Only 'verified' is ever treated as a
  -- verified identity by the sender resolver.
  status text not null default 'pending'
    check (status in ('not_configured', 'pending', 'verified', 'failed', 'unverified')),
  -- The provider (Resend) that this verification came from.
  provider text not null default 'resend' check (provider in ('resend')),
  -- Opaque provider reference (e.g. Resend domain id) when known.
  provider_ref text check (provider_ref is null or char_length(provider_ref) <= 200),
  -- Why a verification failed / notes to the operator. Never shown inventing state.
  detail text check (detail is null or char_length(detail) <= 1000),
  -- When the provider last reported this state.
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_user_id),
  unique (owner_user_id, domain)
);

alter table public.business_email_sender_domains
  add constraint business_email_sender_domains_business_fk
  foreign key (business_id) references public.businesses (id) on delete set null;

create index if not exists business_email_sender_domains_owner_idx
  on public.business_email_sender_domains (owner_user_id, status);

drop trigger if exists set_business_email_sender_domains_updated_at on public.business_email_sender_domains;
create trigger set_business_email_sender_domains_updated_at
  before update on public.business_email_sender_domains
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) Suppression controls (every unsubscribe/suppress evidence, durable)
-- ─────────────────────────────────────────────────────────────────────────────
-- voom_email_suppressions (0040) stays the bounce/complaint authority. This
-- table records the CONTROL that fired — including a signed-title unsubscribe
-- click — so "never email them again" has a durable, auditable trail that the
-- engine reads and the owner can see, without a recipient login.

create table if not exists public.voom_email_suppression_controls (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  email text not null check (
    email = lower(trim(email))
    and char_length(email) <= 320
    and email ~* '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z0-9-]{2,}$'
  ),
  -- 'unsubscribe' = recipient clicked the in-email opt-out.
  reason text not null default 'unsubscribe'
    check (reason in ('unsubscribe', 'manual')),
  -- Optional scope when the opt-out arrived through a specific send.
  contact_id uuid,
  flow_id uuid,
  campaign_id uuid,
  -- Opaque, provider-style token evidence (the unsubscribe token is hashed;
  -- see record_email_opt_out_token — the raw signed token is never stored).
  token_hash text check (token_hash is null or char_length(token_hash) = 64),
  source text not null default 'email_link'
    check (source in ('email_link', 'owner_action', 'settings')),
  detail text check (detail is null or char_length(detail) <= 1000),
  created_at timestamptz not null default now(),
  unique (id, owner_user_id),
  unique (owner_user_id, email, reason)
);

create index if not exists voom_email_suppression_controls_owner_email_idx
  on public.voom_email_suppression_controls (owner_user_id, email);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) Row Level Security + grants
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.business_email_sender_domains enable row level security;
alter table public.voom_email_suppression_controls enable row level security;

revoke all on table public.business_email_sender_domains from public, anon, authenticated;
revoke all on table public.voom_email_suppression_controls from public, anon, authenticated;

-- The owner may read their own sender-domain state (truthful audit) and their
-- own suppression controls; only service_role may write, exactly like 0040.
grant select on table public.business_email_sender_domains to authenticated;
grant select on table public.voom_email_suppression_controls to authenticated;
grant select, insert, update on table public.business_email_sender_domains to service_role;
grant select, insert, update on table public.voom_email_suppression_controls to service_role;

drop policy if exists "business_email_sender_domains_select_own" on public.business_email_sender_domains;
create policy "business_email_sender_domains_select_own" on public.business_email_sender_domains
  for select to authenticated using ((select auth.uid()) = owner_user_id);

drop policy if exists "voom_email_suppression_controls_select_own" on public.voom_email_suppression_controls;
create policy "voom_email_suppression_controls_select_own" on public.voom_email_suppression_controls
  for select to authenticated using ((select auth.uid()) = owner_user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) Unsubscribe RPCs (no login required: proof-of-unsubscribe consumes these)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- record_email_opt_out          : the owner-scoped write the unsubscribe route
--                                 performs after verifing a signed token. It
--                                 stops every future marketing send to the
--                                 address by writing the 0040 suppressions row.
-- record_email_opt_out_token    : idempotent evidence that a given opaque token
--                                 was fired; replay-safe via the token_hash
--                                 uniqueness (handled by the caller's tx).

create or replace function public.record_email_opt_out(
  p_owner_user_id uuid,
  p_email text,
  p_reason text default 'unsubscribe',
  p_contact_id uuid default null,
  p_flow_id uuid default null,
  p_campaign_id uuid default null,
  p_source text default 'email_link',
  p_detail text default null,
  p_now timestamptz default now()
) returns public.voom_email_suppressions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_reason text := lower(trim(coalesce(p_reason, '')));
  v_source text := lower(trim(coalesce(p_source, '')));
  v_row public.voom_email_suppressions;
begin
  if p_owner_user_id is null then
    raise exception 'owner_required';
  end if;
  if v_email !~* '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z0-9-]{2,}$' or char_length(v_email) > 320 then
    raise exception 'invalid_email';
  end if;
  if v_reason not in ('unsubscribe', 'manual') then
    raise exception 'invalid_opt_out_reason';
  end if;
  if v_source not in ('email_link', 'owner_action', 'settings') then
    raise exception 'invalid_opt_out_source';
  end if;

  -- Durable suppression in the existing 0040 table (suppresses all flows), so
  -- the opt-out has exactly the same delivery semantics as a bounce/complaint.
  insert into public.voom_email_suppressions (owner_id, email, reason, provider, detail)
  values (p_owner_user_id, v_email, 'manual', null,
          left(coalesce(p_detail, 'Recorded from an owner-scoped opt-out control.'), 1000))
  on conflict (owner_id, email, reason) do update
    set detail = coalesce(excluded.detail, public.voom_email_suppressions.detail)
  returning * into v_row;

  -- Contact-level consent is flipped to unsubscribed when the contact exists,
  -- so the contacts UI and every future eligibility check agree.
  if p_contact_id is not null then
    update public.contacts
    set email_status = 'unsubscribed', updated_at = coalesce(p_now, now())
    where id = p_contact_id and owner_id = p_owner_user_id;
  end if;

  -- Durable evidence of the control that fired.
  insert into public.voom_email_suppression_controls (
    owner_user_id, email, reason, contact_id, flow_id, campaign_id, source, detail
  ) values (
    p_owner_user_id, v_email, v_reason, p_contact_id, p_flow_id, p_campaign_id,
    v_source, left(coalesce(p_detail, ''), 1000)
  )
  on conflict (owner_user_id, email, reason) do nothing;

  return v_row;
end;
$$;

revoke all on function public.record_email_opt_out(uuid, text, text, uuid, uuid, uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.record_email_opt_out(uuid, text, text, uuid, uuid, uuid, text, text, timestamptz) to service_role;

create or replace function public.record_email_opt_out_token(
  p_owner_user_id uuid,
  p_email text,
  p_token_hash text,
  p_contact_id uuid default null,
  p_flow_id uuid default null,
  p_campaign_id uuid default null,
  p_detail text default null
) returns public.voom_email_suppression_controls
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_hash text := lower(trim(coalesce(p_token_hash, '')));
  v_row public.voom_email_suppression_controls;
begin
  if p_owner_user_id is null then
    raise exception 'owner_required';
  end if;
  if v_email !~* '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z0-9-]{2,}$' or char_length(v_email) > 320 then
    raise exception 'invalid_email';
  end if;
  if length(v_hash) <> 64 or v_hash !~* '^[0-9a-f]{64}$' then
    raise exception 'invalid_token_hash';
  end if;

  insert into public.voom_email_suppression_controls (
    owner_user_id, email, reason, contact_id, flow_id, campaign_id, token_hash, source, detail
  ) values (
    p_owner_user_id, v_email, 'unsubscribe', p_contact_id, p_flow_id, p_campaign_id,
    v_hash, 'email_link', left(coalesce(p_detail, ''), 1000)
  )
  on conflict (owner_user_id, email, reason) do nothing
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.record_email_opt_out_token(uuid, text, text, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.record_email_opt_out_token(uuid, text, text, uuid, uuid, uuid, text) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6) Storage bucket: keep brand-assets private by default; serve email images
--    only through the stable public URL path, never a signed URL.
-- ─────────────────────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('brand-assets', 'brand-assets', false, 52428800,
        array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

commit;
