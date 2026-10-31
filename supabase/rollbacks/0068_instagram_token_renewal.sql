-- Rollback for 0068_instagram_token_renewal.sql.
--
-- Stop the renewal worker schedule first. Removes only the renewal functions,
-- index and bookkeeping columns. Stored tokens, expiry timestamps and statuses
-- are left exactly as they are: a token renewed before rollback stays valid,
-- and a connection marked expired/revoked still needs the owner to reconnect.

begin;

drop function if exists public.claim_instagram_token_refreshes(integer, interval, interval);
drop function if exists public.complete_instagram_token_refresh(uuid, uuid, timestamptz, text, text, text, smallint, timestamptz);
drop function if exists public.fail_instagram_token_refresh(uuid, uuid, timestamptz, text, timestamptz, text);
drop function if exists public.expire_lapsed_instagram_tokens();

drop index if exists public.instagram_connections_renewal_idx;

alter table public.instagram_connection_secrets
  drop constraint if exists instagram_connection_secrets_refresh_failure_count_check,
  drop constraint if exists instagram_connection_secrets_refresh_last_error_check,
  drop column if exists token_refreshed_at,
  drop column if exists refresh_claim_id,
  drop column if exists refresh_claimed_at,
  drop column if exists refresh_failure_count,
  drop column if exists refresh_last_error,
  drop column if exists refresh_next_attempt_at;

commit;
