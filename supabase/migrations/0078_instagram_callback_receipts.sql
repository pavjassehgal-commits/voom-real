-- Instagram deauthorize and data-deletion callbacks (Meta "signed_request" POSTs).
--
-- Narrow by design. One private receipts table plus four service-role-only
-- functions. Existing tables are not altered and existing functions are not
-- redefined. Publishing, scheduling, token renewal, insights and MARA keep their
-- current code: they already stop for any connection whose status is not
-- 'connected' or whose encrypted token row is gone, which is exactly what the
-- existing disconnect does.
--
-- Matching rule: Meta sends an app-scoped user id. VOOM stores the documented
-- app-scoped id (GET /me "id") in instagram_connections.instagram_user_id.
-- Exact string equality only. No username or fuzzy fallback. A callback that
-- matches nothing is kept for human review; it is never silently discarded and
-- never guessed onto another account.
--
-- Deletion is never completed automatically. See docs/instagram-callbacks.md.
-- One-time versioned migration. Rollback: supabase/rollbacks/0078_instagram_callback_receipts.sql

begin;

create table public.instagram_callback_receipts (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('deauthorize', 'deletion')),
  -- Keyed HMAC fingerprint of (app, kind, subject, issued_at): a Meta retry or a
  -- re-encoded copy of the same signed event maps to the same receipt.
  event_key text not null unique check (event_key ~ '^[a-f0-9]{64}$'),
  confirmation_code text not null unique check (confirmation_code ~ '^[a-f0-9]{32}$'),
  app_id text not null check (app_id ~ '^[0-9]{1,40}$'),
  -- Cleared when a deletion completes (data minimisation).
  subject_id text check (subject_id is null or subject_id ~ '^[0-9]{1,40}$'),
  issued_at timestamptz,
  status text not null check (status in (
    'disconnected',      -- deauthorize: matching connection(s) disconnected
    'no_match',          -- deauthorize: nothing matched (kept for review)
    'awaiting_erasure',  -- deletion: received, credentials revoked, operator must run erasure
    'awaiting_review',   -- deletion: dedicated data erased, remaining categories under review
    'completed'          -- deletion: operator recorded every review; only set by complete_instagram_deletion
  )),
  matched_owner_ids uuid[] not null default '{}',
  -- Connections re-authorised AFTER the signed event: not touched automatically.
  superseded_owner_ids uuid[] not null default '{}',
  credentials_revoked_at timestamptz,
  data_erased_at timestamptz,
  erasure_summary jsonb not null default '{}'::jsonb check (jsonb_typeof(erasure_summary) = 'object'),
  reviewed_by text check (reviewed_by is null or char_length(reviewed_by) between 2 and 80),
  review_reference text check (review_reference is null or review_reference ~ '^[A-Za-z0-9._:-]{3,80}$'),
  backups_clear_by date,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'deauthorize') = (status in ('disconnected', 'no_match'))),
  check (status <> 'completed' or (completed_at is not null and data_erased_at is not null
    and reviewed_by is not null and review_reference is not null and backups_clear_by is not null and subject_id is null)),
  check (completed_at is null or status = 'completed')
);

create index instagram_callback_receipts_open_idx on public.instagram_callback_receipts (status, created_at)
  where status in ('no_match', 'awaiting_erasure', 'awaiting_review');

create trigger set_instagram_callback_receipts_updated_at before update on public.instagram_callback_receipts
  for each row execute function public.set_updated_at();

alter table public.instagram_callback_receipts enable row level security;
revoke all on table public.instagram_callback_receipts from public, anon, authenticated;
-- No policies: browsers can never read or write receipts.

-- 1) Called by the two HTTP callbacks after the signature is verified.
create or replace function public.accept_instagram_callback(
  p_app_id text, p_subject_id text, p_kind text, p_issued_at timestamptz, p_event_key text
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  receipt public.instagram_callback_receipts%rowtype;
  conn record;
  matched uuid[] := '{}';
  superseded uuid[] := '{}';
begin
  if p_kind not in ('deauthorize', 'deletion') or p_subject_id !~ '^[0-9]{1,40}$'
     or p_app_id !~ '^[0-9]{1,40}$' or p_event_key !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid_callback' using errcode = '22023';
  end if;

  insert into public.instagram_callback_receipts (kind, event_key, confirmation_code, app_id, subject_id, issued_at, status)
  values (p_kind, p_event_key, replace(gen_random_uuid()::text, '-', ''), p_app_id, p_subject_id, p_issued_at,
          case when p_kind = 'deletion' then 'awaiting_erasure' else 'no_match' end)
  on conflict (event_key) do nothing
  returning * into receipt;

  if not found then
    -- Duplicate delivery of the same signed event: same receipt, no second action.
    select * into receipt from public.instagram_callback_receipts where event_key = p_event_key;
    -- The id may have been cleared after a completed deletion (data minimisation); a Meta
    -- retry of that same event must still get its original code, never an error loop.
    if receipt.kind <> p_kind or (receipt.subject_id is not null and receipt.subject_id <> p_subject_id) then
      raise exception 'event_key_conflict' using errcode = '23505';
    end if;
    return receipt.confirmation_code;
  end if;

  for conn in
    select id, owner_user_id, connected_at from public.instagram_connections
    where instagram_user_id = p_subject_id
    order by owner_user_id
    for update
  loop
    if p_issued_at is not null and conn.connected_at > p_issued_at then
      -- Re-authorised after Meta signed this event: never revoke the newer authorisation automatically.
      superseded := superseded || conn.owner_user_id;
    else
      -- Same effect as the user's own "Disconnect" (public.disconnect_instagram_connection).
      delete from public.instagram_connection_secrets where connection_id = conn.id;
      update public.instagram_connections
        set status = 'disconnected', disconnected_at = now(), token_expires_at = null
        where id = conn.id;
      matched := matched || conn.owner_user_id;
    end if;
  end loop;

  update public.instagram_callback_receipts set
    matched_owner_ids = matched,
    superseded_owner_ids = superseded,
    credentials_revoked_at = case when cardinality(matched) > 0 then now() end,
    status = case when p_kind = 'deletion' then 'awaiting_erasure'
                  when cardinality(matched) > 0 then 'disconnected' else 'no_match' end
  where id = receipt.id;

  return receipt.confirmation_code;
end;
$$;

-- 2) Operator step: erase the Instagram Platform Data VOOM holds for the matched owner(s).
create or replace function public.erase_instagram_deletion_data(p_confirmation_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  receipt public.instagram_callback_receipts%rowtype;
  owner_id uuid;
  n integer;
  summary jsonb := jsonb_build_object('owners', 0, 'secrets', 0, 'profiles_scrubbed', 0, 'insight_snapshots', 0,
    'performance_snapshots', 0, 'oauth_states', 0, 'unpublished_provider_ids', 0);
begin
  select * into receipt from public.instagram_callback_receipts
    where confirmation_code = p_confirmation_code and kind = 'deletion' for update;
  if not found then raise exception 'receipt_not_found' using errcode = 'P0002'; end if;
  if receipt.status <> 'awaiting_erasure' then raise exception 'receipt_not_awaiting_erasure' using errcode = '55000'; end if;
  if cardinality(receipt.superseded_owner_ids) > 0 then
    -- A newer authorisation exists; a person must decide what belongs to which authorisation.
    raise exception 'superseded_connection_requires_manual_review' using errcode = '55000';
  end if;

  foreach owner_id in array receipt.matched_owner_ids loop
    -- Refuse if the owner connected Instagram again after the request: that data is a new authorisation.
    perform 1 from public.instagram_connections c
      where c.owner_user_id = owner_id and c.status = 'connected' and c.connected_at > receipt.created_at for update;
    if found then raise exception 'reconnected_after_request_requires_manual_review' using errcode = '55000'; end if;

    delete from public.instagram_connection_secrets where owner_user_id = owner_id;
    get diagnostics n = row_count; summary := jsonb_set(summary, '{secrets}', to_jsonb((summary->>'secrets')::int + n));

    update public.instagram_connections set
      instagram_user_id = 'erased', username = 'erased', display_name = null, account_type = null,
      profile_picture_url = null, scopes = '{}', status = 'disconnected',
      disconnected_at = coalesce(disconnected_at, now()), token_expires_at = null, last_synced_at = null
      where owner_user_id = owner_id;
    get diagnostics n = row_count; summary := jsonb_set(summary, '{profiles_scrubbed}', to_jsonb((summary->>'profiles_scrubbed')::int + n));

    delete from public.instagram_insight_snapshots where owner_user_id = owner_id;
    get diagnostics n = row_count; summary := jsonb_set(summary, '{insight_snapshots}', to_jsonb((summary->>'insight_snapshots')::int + n));

    delete from public.instagram_performance_snapshots where owner_user_id = owner_id;
    get diagnostics n = row_count; summary := jsonb_set(summary, '{performance_snapshots}', to_jsonb((summary->>'performance_snapshots')::int + n));

    delete from public.instagram_oauth_states where owner_user_id = owner_id;
    get diagnostics n = row_count; summary := jsonb_set(summary, '{oauth_states}', to_jsonb((summary->>'oauth_states')::int + n));

    -- Provider ids on items that never published. Published rows keep their media id
    -- (a database rule requires it); they are listed for the publish-history review.
    update public.instagram_publish_queue set container_id = null, instagram_media_id = null
      where owner_user_id = owner_id and status <> 'published' and (container_id is not null or instagram_media_id is not null);
    get diagnostics n = row_count; summary := jsonb_set(summary, '{unpublished_provider_ids}', to_jsonb((summary->>'unpublished_provider_ids')::int + n));
    update public.instagram_publish_jobs set instagram_container_id = null, instagram_media_id = null
      where owner_user_id = owner_id and status <> 'published' and (instagram_container_id is not null or instagram_media_id is not null);
    get diagnostics n = row_count; summary := jsonb_set(summary, '{unpublished_provider_ids}', to_jsonb((summary->>'unpublished_provider_ids')::int + n));

    summary := jsonb_set(summary, '{owners}', to_jsonb((summary->>'owners')::int + 1));
  end loop;

  select count(*) into n from public.instagram_publish_queue
    where owner_user_id = any(receipt.matched_owner_ids) and status = 'published';
  summary := summary || jsonb_build_object('published_items_for_review', n);

  update public.instagram_callback_receipts set
    status = 'awaiting_review', data_erased_at = now(), erasure_summary = summary,
    credentials_revoked_at = coalesce(credentials_revoked_at, case when cardinality(matched_owner_ids) > 0 then now() end)
    where id = receipt.id;
  return summary;
end;
$$;

-- 3) Operator step: record the human review and complete. Refuses anything unfinished.
--    p_identity_reviewed: right VOOM owner(s) matched, or a no-data search was done.
--    p_publish_history_reviewed: published rows still carrying Meta media ids were decided.
--    p_processors_reviewed: AI-derived Instagram text (campaign summaries, plans, MARA replies)
--      was removed or redacted, and external processor retention was checked.
--    Runbook: docs/instagram-callbacks.md section 5.
create or replace function public.complete_instagram_deletion(
  p_confirmation_code text, p_reviewed_by text, p_review_reference text,
  p_identity_reviewed boolean, p_publish_history_reviewed boolean, p_processors_reviewed boolean,
  p_backups_clear_by date
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  receipt public.instagram_callback_receipts%rowtype;
begin
  select * into receipt from public.instagram_callback_receipts
    where confirmation_code = p_confirmation_code and kind = 'deletion' for update;
  if not found then raise exception 'receipt_not_found' using errcode = 'P0002'; end if;
  if receipt.status <> 'awaiting_review' or receipt.data_erased_at is null then
    raise exception 'erasure_not_finished' using errcode = '55000';
  end if;
  if p_identity_reviewed is not true or p_publish_history_reviewed is not true or p_processors_reviewed is not true then
    raise exception 'review_incomplete' using errcode = '55000';
  end if;
  if p_backups_clear_by is null or p_backups_clear_by < receipt.data_erased_at::date then
    raise exception 'backup_date_required' using errcode = '22023';
  end if;
  if coalesce(char_length(trim(p_reviewed_by)), 0) < 2 or p_review_reference !~ '^[A-Za-z0-9._:-]{3,80}$' then
    raise exception 'reviewer_required' using errcode = '22023';
  end if;
  -- Data minimisation: once this deletion is complete, no other receipt keeps the person's
  -- Instagram id (for example the deauthorize receipt Meta sends just before a deletion).
  -- Another deletion for the same id that is still in progress keeps it until its own completion.
  update public.instagram_callback_receipts set subject_id = null
    where id <> receipt.id and subject_id = receipt.subject_id
      and not (kind = 'deletion' and status in ('awaiting_erasure', 'awaiting_review'));
  update public.instagram_callback_receipts set
    status = 'completed', completed_at = now(), reviewed_by = trim(p_reviewed_by),
    review_reference = p_review_reference, backups_clear_by = p_backups_clear_by, subject_id = null
    where id = receipt.id;
  return true;
end;
$$;

-- 4) Public status page lookup by unguessable code. Returns no identity.
create or replace function public.instagram_deletion_status(p_confirmation_code text)
returns table (status text, received_at timestamptz, completed_at timestamptz, backups_clear_by date)
language sql
stable
security definer
set search_path = ''
as $$
  select r.status, r.created_at, r.completed_at, r.backups_clear_by
  from public.instagram_callback_receipts r
  where r.confirmation_code = p_confirmation_code and r.kind = 'deletion';
$$;

revoke all on function public.accept_instagram_callback(text, text, text, timestamptz, text) from public, anon, authenticated;
revoke all on function public.erase_instagram_deletion_data(text) from public, anon, authenticated;
revoke all on function public.complete_instagram_deletion(text, text, text, boolean, boolean, boolean, date) from public, anon, authenticated;
revoke all on function public.instagram_deletion_status(text) from public, anon, authenticated;
grant execute on function public.accept_instagram_callback(text, text, text, timestamptz, text) to service_role;
grant execute on function public.erase_instagram_deletion_data(text) to service_role;
grant execute on function public.complete_instagram_deletion(text, text, text, boolean, boolean, boolean, date) to service_role;
grant execute on function public.instagram_deletion_status(text) to service_role;

commit;
