-- 0042_branded_email_url_regex_fix.sql
-- BUG FIX: “Add image” failed for every upload with
--   “Voom couldn't register that image safely. Nothing was published.”
--
-- ROOT CAUSE
--   Migration 0041 validated URLs with POSIX bounded repetitions whose upper
--   bound exceeds PostgreSQL's hard limit of 255:
--
--       public_url ~* '^https?://[^[:space:]]{1,2000}$'
--       website    ~* '^https?://[^[:space:]]{1,500}$'
--
--   PostgreSQL compiles `{m,n}` bounds into a single byte, so any bound above
--   255 makes the *regular expression itself* invalid. Evaluating it raises
--   SQLSTATE 2201B `invalid_regular_expression`
--   (“invalid repetition count(s)”) — not a failed validation, an ERROR.
--
--   Two consequences, both hit by a completely normal upload:
--     1. `public.create_email_asset()` raises 2201B at its public_url guard,
--        before the insert. PostgREST turns that into a 5xx, supabase-js
--        returns `error`, and lib/email/branded/assets.ts throws
--        `persist_failed` — the exact message the owner saw.
--     2. The table CHECK `voom_email_assets_public_url_check` contains the
--        same invalid regex, so even a bypassed guard would fail on INSERT.
--
--   Because the guard runs before the write, the failure is 100% reproducible
--   for every JPEG/PNG/WebP upload, which is why no image ever appeared.
--
--   The same defect was copied into the sibling brand/CTA guards in 0041:
--     - voom_email_brands.website          CHECK  {1,500}
--     - voom_campaigns.cta_url             CHECK  {1,500}
--     - upsert_email_brand()'s website guard      {1,500}
--   all of which fail identically the moment an owner saves a website or a
--   campaign CTA destination.
--
-- FIX
--   Keep the intent of every guard byte-for-byte — the URL must start with
--   http(s)://, must contain no whitespace, and must stay bounded — but
--   express the bound the way PostgreSQL can compile it: an unbounded
--   non-whitespace run (`+`) plus an explicit `char_length()` cap.
--
--       ^https?://[^[:space:]]{1,N}$   →   ^https?://[^[:space:]]+$
--                                          and char_length(x) <= N
--
--   Nothing about the security model changes: the URL must still be http(s),
--   still whitespace-free, still length-capped, and the RPCs remain
--   SECURITY DEFINER, service-role-only, owner-scoped. 0040 and 0041 are NOT
--   modified — this file only re-declares the two affected functions and the
--   three affected CHECK constraints on top of them.
--
-- Non-destructive: no table is rewritten, no row is deleted or rewritten, no
-- data migration, no provider call, no cron, no media spend.

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) CHECK constraints — replace the three uncompilable regexes
-- ─────────────────────────────────────────────────────────────────────────────

-- voom_email_assets was created by 0041 and every insert into it has failed
-- with 2201B, so it holds no rows and the validated constraint is instant.
alter table public.voom_email_assets
  drop constraint if exists voom_email_assets_public_url_check;
alter table public.voom_email_assets
  add constraint voom_email_assets_public_url_check
  check (
    public_url ~* '^https?://[^[:space:]]+$'
    and char_length(public_url) <= 2000
  );

alter table public.voom_email_brands
  drop constraint if exists voom_email_brands_website_check;
alter table public.voom_email_brands
  add constraint voom_email_brands_website_check
  check (
    website is null
    or (website ~* '^https?://[^[:space:]]+$' and char_length(website) <= 500)
  );

-- voom_campaigns is a live, pre-existing table: add the replacement WITHOUT a
-- full-table validation lock, then validate it separately (SHARE UPDATE
-- EXCLUSIVE — reads and writes keep working while the scan runs). cta_url is a
-- 0041-added column that is NULL on every existing row, so validation is safe.
alter table public.voom_campaigns
  drop constraint if exists voom_campaigns_cta_url_check;
alter table public.voom_campaigns
  add constraint voom_campaigns_cta_url_check
  check (
    cta_url is null
    or (cta_url ~* '^https?://[^[:space:]]+$' and char_length(cta_url) <= 500)
  ) not valid;
alter table public.voom_campaigns
  validate constraint voom_campaigns_cta_url_check;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) public.create_email_asset — the only change is the public_url guard
-- ─────────────────────────────────────────────────────────────────────────────

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
  -- 0041 bug fix: `{1,2000}` is an INVALID PostgreSQL bounded repetition
  -- (bounds above 255 raise 2201B). Same guard, compilable spelling: an
  -- unbounded whitespace-free run plus an explicit length cap.
  if v_public_url !~* '^https?://[^[:space:]]+$' or char_length(v_public_url) > 2000 then
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) public.upsert_email_brand — the only change is the website guard
-- ─────────────────────────────────────────────────────────────────────────────

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
  -- 0041 bug fix: `{1,500}` is an INVALID PostgreSQL bounded repetition
  -- (bounds above 255 raise 2201B). Same guard, compilable spelling.
  if v_website is not null
     and (v_website !~* '^https?://[^[:space:]]+$' or char_length(v_website) > 500) then
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

commit;
