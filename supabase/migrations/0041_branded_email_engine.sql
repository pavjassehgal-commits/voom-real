-- 0041_branded_email_engine.sql
-- Branded Email Engine v1 — per-business sender identity, email brand
-- profile, email-safe assets, working unsubscribe, campaign CTA destination.
--
-- WHY THIS EXISTS
--   The first production lifecycle email proved the delivery stack works but
--   exposed a product-quality problem: every send went out as
--   "Voom <EMAIL_FROM_ADDRESS>" with a plain-text body. The recipient
--   experienced Voom, not their business. This migration adds the durable
--   state the new engine needs:
--
--     1. voom_email_identities   per-business sender identity (display name,
--        requested sending address, reply-to, verification state)
--     2. voom_email_assets       the register of assets explicitly published
--        for email use, served from a PUBLIC bucket with durable URLs (email
--        clients must be able to fetch images long after delivery; the
--        private mara-media bucket and its signed URLs are never used)
--     3. voom_email_brands       email-specific brand profile (logo asset,
--        colours, website, footer line). Everything already on businesses
--        (name, description, industry, tone) stays there — no duplicates.
--     4. voom_email_unsubscribes durable record of every real unsubscribe
--        performed through a working link in a sent email
--     5. voom_campaigns.cta_url  an explicit campaign destination, so a
--        campaign CTA button always points at a URL the business configured
--
-- SPoF RULES (mirrors 0040's truthfulness discipline)
--   - Nothing here can mark a domain verified. Only
--     record_email_identity_verification writes verification_status, and the
--     application layer only calls it with provider-backed state.
--   - Unsubscribe links use opaque HMAC-signed tokens; the table stores the
--     RESULT of an unsubscribe, not the token.
--   - No new provider calls, no media generation, no cron, no data rewrite.
--
-- Additive and non-destructive. Existing rows, 0040 semantics (revisions,
-- snapshots, claims, suppression) and every already-delivered email are
-- untouched. DO NOT modify or rerun 0040.

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) voom_email_identities — one row per business
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.voom_email_identities (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete cascade,

  -- What the recipient's inbox shows, e.g. "SynraPay".
  display_name text check (display_name is null or char_length(display_name) between 1 and 120),

  -- The address the business wants to send from, e.g. hello@synrapay.com.
  -- NEVER used for sending unless the provider confirms the domain; until
  -- then the safe Voom-managed sending identity is used with this display
  -- name. Validated here and again in the writer RPC.
  from_address text check (
    from_address is null
    or (from_address = lower(from_address) and from_address ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$' and char_length(from_address) <= 320)
  ),

  -- Where customer replies go. Any syntactically valid address is accepted
  -- (reply routing is not sender identity, so it does not require domain
  -- verification) and validated server-side.
  reply_to text check (
    reply_to is null
    or (reply_to = lower(reply_to) and reply_to ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$' and char_length(reply_to) <= 320)
  ),

  -- Display hint for the settings UI. NOT trusted by the resolver: a sender
  -- is only ever treated as verified when the provider says so at resolve
  -- time. Updated exclusively by record_email_identity_verification.
  verification_status text not null default 'not_configured'
    check (verification_status in ('not_configured', 'pending', 'verified', 'failed')),
  last_checked_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, owner_user_id),
  unique (owner_user_id)
);

create index if not exists voom_email_identities_business_idx
  on public.voom_email_identities (business_id);

drop trigger if exists set_voom_email_identities_updated_at on public.voom_email_identities;
create trigger set_voom_email_identities_updated_at
  before update on public.voom_email_identities
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) voom_email_assets — assets explicitly published for email delivery
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Only objects in the PUBLIC voom-email-assets bucket (random names, copied
-- server-side when an owner explicitly publishes an asset) are ever
-- referenced from an email. Private mara-media objects and short-lived signed
-- URLs are never embedded: an email outlives both by years.

create table if not exists public.voom_email_assets (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete cascade,

  public_path text not null check (char_length(public_path) between 20 and 500),
  public_url text not null check (
    public_url ~* '^https?://[^[:space:]]{1,2000}$'
  ),
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  byte_size bigint not null check (byte_size between 1 and 10485760),
  alt_text text check (alt_text is null or char_length(alt_text) between 1 and 200),
  width integer check (width is null or width between 1 and 4000),
  height integer check (height is null or height between 1 and 4000),

  -- Where the bytes came from. 'generated_preexisting' is reserved for
  -- Voom-generated imagery the owner already approved — v1 publishes nothing
  -- generated automatically, ever.
  source_kind text not null default 'uploaded'
    check (source_kind in ('uploaded', 'from_draft_asset', 'from_reel_asset', 'generated_preexisting')),
  source_draft_id uuid,

  status text not null default 'ready' check (status in ('ready', 'removed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, owner_user_id),
  unique (owner_user_id, public_path)
);

create index if not exists voom_email_assets_owner_status_idx
  on public.voom_email_assets (owner_user_id, status, created_at desc);
create index if not exists voom_email_assets_business_idx
  on public.voom_email_assets (business_id);

drop trigger if exists set_voom_email_assets_updated_at on public.voom_email_assets;
create trigger set_voom_email_assets_updated_at
  before update on public.voom_email_assets
  for each row execute function public.set_updated_at();

-- The public email bucket. Objects here are owner-published email assets
-- under randomly named keys; nothing private is ever written to this bucket.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('voom-email-assets', 'voom-email-assets', true, 10485760, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) voom_email_brands — email-specific brand profile (one row per business)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.voom_email_brands (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete cascade,

  -- Logo: always a row from voom_email_assets (published, owner-authorized).
  logo_asset_id uuid,
  primary_color text check (
    primary_color is null or primary_color ~ '^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$'
  ),
  secondary_color text check (
    secondary_color is null or secondary_color ~ '^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$'
  ),
  website text check (
    website is null or (website ~* '^https?://[^[:space:]]{1,500}$')
  ),
  footer_line text check (footer_line is null or char_length(footer_line) between 1 and 500),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, owner_user_id),
  unique (owner_user_id),
  foreign key (logo_asset_id, owner_user_id)
    references public.voom_email_assets (id, owner_user_id) on delete set null (logo_asset_id)
);

create index if not exists voom_email_brands_business_idx
  on public.voom_email_brands (business_id);

drop trigger if exists set_voom_email_brands_updated_at on public.voom_email_brands;
create trigger set_voom_email_brands_updated_at
  before update on public.voom_email_brands
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) voom_email_unsubscribes — durable unsubscribe results
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The LINK itself is an opaque HMAC-signed token minted server-side at send
-- time; the token is never stored. This table records that a recipient
-- actually unsubscribed (idempotent per owner + address) so the history is
-- auditable and the suppression side-effect (voom_email_suppressions,
-- reason 'manual') can be traced to a real click.

create table if not exists public.voom_email_unsubscribes (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  email text not null check (
    email = lower(trim(email))
    and char_length(email) <= 320
    and email ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'
  ),
  contact_id uuid,
  source text not null default 'email_footer'
    check (source in ('email_footer', 'manual')),
  created_at timestamptz not null default now(),

  unique (id, owner_user_id),
  unique (owner_user_id, email)
);

create index if not exists voom_email_unsubscribes_owner_email_idx
  on public.voom_email_unsubscribes (owner_user_id, email);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) voom_campaigns — explicit CTA destination
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.voom_campaigns
  add column if not exists cta_url text
  check (cta_url is null or (cta_url ~* '^https?://[^[:space:]]{1,500}$'));

-- ─────────────────────────────────────────────────────────────────────────────
-- Row Level Security — owner-scoped reads, service-role writes
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.voom_email_identities enable row level security;
alter table public.voom_email_brands enable row level security;
alter table public.voom_email_assets enable row level security;
alter table public.voom_email_unsubscribes enable row level security;

revoke all on table public.voom_email_identities, public.voom_email_brands,
  public.voom_email_assets, public.voom_email_unsubscribes from public, anon, authenticated;

-- The browser may read its own rows (the settings + preview surfaces); every
-- write goes through the service-role RPCs below. No authenticated
-- insert/update/delete anywhere in the Branded Email Engine.
grant select on table public.voom_email_identities to authenticated;
grant select on table public.voom_email_brands to authenticated;
grant select on table public.voom_email_assets to authenticated;
grant select on table public.voom_email_unsubscribes to authenticated;

grant select, insert, update, delete on table public.voom_email_identities to service_role;
grant select, insert, update, delete on table public.voom_email_brands to service_role;
grant select, insert, update, delete on table public.voom_email_assets to service_role;
grant select, insert, update, delete on table public.voom_email_unsubscribes to service_role;

drop policy if exists "voom_email_identities_select_own" on public.voom_email_identities;
create policy "voom_email_identities_select_own" on public.voom_email_identities
  for select to authenticated using ((select auth.uid()) = owner_user_id);
drop policy if exists "voom_email_brands_select_own" on public.voom_email_brands;
create policy "voom_email_brands_select_own" on public.voom_email_brands
  for select to authenticated using ((select auth.uid()) = owner_user_id);
drop policy if exists "voom_email_assets_select_own" on public.voom_email_assets;
create policy "voom_email_assets_select_own" on public.voom_email_assets
  for select to authenticated using ((select auth.uid()) = owner_user_id);
drop policy if exists "voom_email_unsubscribes_select_own" on public.voom_email_unsubscribes;
create policy "voom_email_unsubscribes_select_own" on public.voom_email_unsubscribes
  for select to authenticated using ((select auth.uid()) = owner_user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Writer RPCs — the only write path, service_role only
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Upsert the business sender identity. Cannot set verification_status —
--    only record_email_identity_verification may, and only with
--    provider-backed state.
create or replace function public.upsert_email_identity(
  p_owner_user_id uuid,
  p_payload jsonb
) returns public.voom_email_identities
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_display_name text := nullif(trim(coalesce(p_payload ->> 'displayName', '')), '');
  v_from_address text := nullif(lower(trim(coalesce(p_payload ->> 'fromAddress', ''))), '');
  v_reply_to text := nullif(lower(trim(coalesce(p_payload ->> 'replyTo', ''))), '');
  v_row public.voom_email_identities;
  v_business public.businesses;
begin
  if p_owner_user_id is null then
    raise exception 'owner_required';
  end if;

  select * into v_business from public.businesses
  where owner_user_id = p_owner_user_id
  limit 1;
  if not found then
    raise exception 'business_not_found';
  end if;

  if v_display_name is not null and char_length(v_display_name) > 120 then
    raise exception 'invalid_display_name';
  end if;
  if v_from_address is not null and v_from_address !~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$' then
    raise exception 'invalid_from_address';
  end if;
  if v_reply_to is not null and v_reply_to !~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$' then
    raise exception 'invalid_reply_to';
  end if;

  insert into public.voom_email_identities
    (owner_user_id, business_id, display_name, from_address, reply_to)
  values
    (p_owner_user_id, v_business.id, v_display_name, v_from_address, v_reply_to)
  on conflict (owner_user_id) do update
    set display_name = coalesce(excluded.display_name, public.voom_email_identities.display_name),
        from_address = coalesce(excluded.from_address, public.voom_email_identities.from_address),
        reply_to = coalesce(excluded.reply_to, public.voom_email_identities.reply_to)
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.upsert_email_identity(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.upsert_email_identity(uuid, jsonb) to service_role;

-- 2. The ONLY writer of verification state.
create or replace function public.record_email_identity_verification(
  p_owner_user_id uuid,
  p_status text,
  p_checked_at timestamptz default now()
) returns public.voom_email_identities
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.voom_email_identities;
begin
  if p_owner_user_id is null then
    raise exception 'owner_required';
  end if;
  if p_status not in ('not_configured', 'pending', 'verified', 'failed') then
    raise exception 'invalid_verification_status';
  end if;

  update public.voom_email_identities
  set verification_status = p_status,
      last_checked_at = p_checked_at
  where owner_user_id = p_owner_user_id
  returning * into v_row;

  if not found then
    insert into public.voom_email_identities
      (owner_user_id, verification_status, last_checked_at)
    values
      (p_owner_user_id, p_status, p_checked_at)
    returning * into v_row;
  end if;

  return v_row;
end;
$$;

revoke all on function public.record_email_identity_verification(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.record_email_identity_verification(uuid, text, timestamptz) to service_role;

-- 3. Upsert the email brand profile. The logo must reference a real,
--    ready, owner-owned email asset.
create or replace function public.upsert_email_brand(
  p_owner_user_id uuid,
  p_payload jsonb
) returns public.voom_email_brands
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_logo_asset_id uuid := nullif((p_payload ->> 'logoAssetId')::text, '')::uuid;
  v_primary_color text := nullif(trim(coalesce(p_payload ->> 'primaryColor', '')), '');
  v_secondary_color text := nullif(trim(coalesce(p_payload ->> 'secondaryColor', '')), '');
  v_website text := nullif(trim(coalesce(p_payload ->> 'website', '')), '');
  v_footer_line text := nullif(trim(coalesce(p_payload ->> 'footerLine', '')), '');
  v_row public.voom_email_brands;
  v_business public.businesses;
begin
  if p_owner_user_id is null then
    raise exception 'owner_required';
  end if;

  select * into v_business from public.businesses
  where owner_user_id = p_owner_user_id
  limit 1;
  if not found then
    raise exception 'business_not_found';
  end if;

  if v_logo_asset_id is not null then
    if not exists (
      select 1 from public.voom_email_assets
      where id = v_logo_asset_id and owner_user_id = p_owner_user_id and status = 'ready'
    ) then
      raise exception 'logo_asset_not_found';
    end if;
  end if;
  if v_primary_color is not null and v_primary_color !~ '^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$' then
    raise exception 'invalid_primary_color';
  end if;
  if v_secondary_color is not null and v_secondary_color !~ '^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$' then
    raise exception 'invalid_secondary_color';
  end if;
  if v_website is not null and v_website !~* '^https?://[^[:space:]]{1,500}$' then
    raise exception 'invalid_website';
  end if;
  if v_footer_line is not null and char_length(v_footer_line) > 500 then
    raise exception 'footer_line_too_long';
  end if;

  insert into public.voom_email_brands
    (owner_user_id, business_id, logo_asset_id, primary_color, secondary_color, website, footer_line)
  values
    (p_owner_user_id, v_business.id, v_logo_asset_id, v_primary_color, v_secondary_color, v_website, v_footer_line)
  on conflict (owner_user_id) do update
    set logo_asset_id = coalesce(excluded.logo_asset_id, public.voom_email_brands.logo_asset_id),
        primary_color = coalesce(excluded.primary_color, public.voom_email_brands.primary_color),
        secondary_color = coalesce(excluded.secondary_color, public.voom_email_brands.secondary_color),
        website = coalesce(excluded.website, public.voom_email_brands.website),
        footer_line = coalesce(excluded.footer_line, public.voom_email_brands.footer_line)
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.upsert_email_brand(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.upsert_email_brand(uuid, jsonb) to service_role;

-- 4. Register a published email asset.
create or replace function public.create_email_asset(
  p_owner_user_id uuid,
  p_payload jsonb
) returns public.voom_email_assets
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_public_path text := trim(coalesce(p_payload ->> 'publicPath', ''));
  v_public_url text := trim(coalesce(p_payload ->> 'publicUrl', ''));
  v_mime_type text := trim(coalesce(p_payload ->> 'mimeType', ''));
  v_byte_size bigint := (p_payload ->> 'byteSize')::bigint;
  v_alt_text text := nullif(trim(coalesce(p_payload ->> 'altText', '')), '');
  v_width integer := nullif((p_payload ->> 'width')::text, '')::int;
  v_height integer := nullif((p_payload ->> 'height')::text, '')::int;
  v_source_kind text := trim(coalesce(p_payload ->> 'sourceKind', 'uploaded'));
  v_source_draft_id uuid := nullif((p_payload ->> 'sourceDraftId')::text, '')::uuid;
  v_row public.voom_email_assets;
  v_business public.businesses;
begin
  if p_owner_user_id is null then
    raise exception 'owner_required';
  end if;

  select * into v_business from public.businesses
  where owner_user_id = p_owner_user_id
  limit 1;
  if not found then
    raise exception 'business_not_found';
  end if;

  if char_length(v_public_path) < 20 or char_length(v_public_path) > 500 then
    raise exception 'invalid_public_path';
  end if;
  if v_public_url !~* '^https?://[^[:space:]]{1,2000}$' then
    raise exception 'invalid_public_url';
  end if;
  if v_mime_type not in ('image/jpeg', 'image/png', 'image/webp') then
    raise exception 'invalid_mime_type';
  end if;
  if v_byte_size is null or v_byte_size < 1 or v_byte_size > 10485760 then
    raise exception 'invalid_byte_size';
  end if;
  if v_alt_text is not null and char_length(v_alt_text) > 200 then
    raise exception 'alt_text_too_long';
  end if;
  if v_source_kind not in ('uploaded', 'from_draft_asset', 'from_reel_asset', 'generated_preexisting') then
    raise exception 'invalid_source_kind';
  end if;

  insert into public.voom_email_assets
    (owner_user_id, business_id, public_path, public_url, mime_type, byte_size,
     alt_text, width, height, source_kind, source_draft_id)
  values
    (p_owner_user_id, v_business.id, v_public_path, v_public_url, v_mime_type, v_byte_size,
     v_alt_text, v_width, v_height, v_source_kind, v_source_draft_id)
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.create_email_asset(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.create_email_asset(uuid, jsonb) to service_role;

-- 5. Mark an email asset removed (its object is deleted by the caller).
create or replace function public.remove_email_asset(
  p_owner_user_id uuid,
  p_asset_id uuid
) returns public.voom_email_assets
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.voom_email_assets;
begin
  if p_owner_user_id is null then
    raise exception 'owner_required';
  end if;
  if p_asset_id is null then
    raise exception 'asset_required';
  end if;

  update public.voom_email_assets
  set status = 'removed'
  where id = p_asset_id and owner_user_id = p_owner_user_id
  returning * into v_row;

  if not found then
    raise exception 'asset_not_found';
  end if;

  return v_row;
end;
$$;

revoke all on function public.remove_email_asset(uuid, uuid) from public, anon, authenticated;
grant execute on function public.remove_email_asset(uuid, uuid) to service_role;

-- 6. Record a real unsubscribe performed through a verified token.
--    Idempotent per owner + address, and writes the durable suppression so
--    every future marketing send (campaign or flow) fails closed against it.
create or replace function public.record_email_unsubscribe(
  p_owner_user_id uuid,
  p_email text,
  p_contact_id uuid default null,
  p_source text default 'email_footer'
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_unsubscribed_at timestamptz;
begin
  if p_owner_user_id is null then
    raise exception 'owner_required';
  end if;
  if v_email = '' or v_email !~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$' then
    raise exception 'invalid_email';
  end if;
  if p_source not in ('email_footer', 'manual') then
    raise exception 'invalid_source';
  end if;

  insert into public.voom_email_unsubscribes (owner_user_id, email, contact_id, source)
  values (p_owner_user_id, v_email, p_contact_id, p_source)
  on conflict (owner_user_id, email) do nothing;

  -- Durable suppression, same table every lifecycle send fails closed against.
  insert into public.voom_email_suppressions (owner_id, email, reason, detail)
  values (p_owner_user_id, v_email, 'manual', 'Unsubscribed through the unsubscribe link in a marketing email.')
  on conflict (owner_id, email, reason) do nothing;

  -- Consent truthfulness: the contact itself becomes unsubscribed, so
  -- audience eligibility and single-recipient sends both exclude it.
  update public.contacts
  set email_status = 'unsubscribed'
  where owner_id = p_owner_user_id
    and lower(trim(email)) = v_email;

  select now() into v_unsubscribed_at;

  return jsonb_build_object(
    'status', 'unsubscribed',
    'email', v_email,
    'at', v_unsubscribed_at
  );
end;
$$;

revoke all on function public.record_email_unsubscribe(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.record_email_unsubscribe(uuid, text, uuid, text) to service_role;

commit;
