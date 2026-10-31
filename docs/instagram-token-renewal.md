# Instagram token renewal

Instagram API with Instagram Login issues long-lived tokens valid for 60 days.
Meta's `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token`
renews one for another 60 days only while it is at least 24 hours old,
unexpired and granted `instagram_business_basic`. An expired token cannot be
refreshed; the owner must reconnect. Before this change Voom never renewed
tokens, so every connection silently stopped working 60 days after connecting.

## How it works

- `/api/cron/instagram-token-refresh` (CRON_SECRET Bearer, counts-only
  response) runs `lib/instagram/token-renewal.ts` every 6 hours.
- Each run marks connections whose token already lapsed `expired`, then claims
  up to 10 connected tokens with fewer than 30 days left
  (`claim_instagram_token_refreshes`: `for update skip locked` plus a
  10-minute lease), so overlapping runs never renew the same connection.
- The renewed token is encrypted with the PRIMARY key, verified, and stored with
  its new expiry in one transaction (`complete_instagram_token_refresh`), only
  for the still-current claim and only if the owner has not reconnected since.
- Failures keep the stored credential. Throttling retries after 12 hours, other
  transient failures after 6 hours (about 120 attempts inside the 30-day
  window). Meta error 190 marks the connection `expired`, missing permission
  (10 / 200-299) marks it `revoked`; Channels then shows *Reconnect Instagram*.
  A token that cannot be decrypted is treated as a key problem, never as a
  reason to ask the owner to reconnect.
- Tokens, owner ids and provider responses are never logged or returned.

Do not run the staged key rotation (`/api/admin/instagram/rotate-token-key`)
while a renewal run is in progress: rotation rewrites ciphertext without a
compare-and-swap and could restore the pre-renewal token.

## Release steps (each needs separate approval)

1. Apply `supabase/migrations/0068_instagram_token_renewal.sql` once to staging,
   then Production (SQL editor, transaction-wrapped; adds six nullable/defaulted
   columns, one partial index and four service-role-only functions; no backfill,
   no provider call). SHA-256 `bf826ae0fad0bbdfc74c331685845690426adce6c897670db34836839c347992`.
   Rollback: `supabase/rollbacks/0068_instagram_token_renewal.sql`
   (SHA-256 `b9d0c720f25e3610b5b0d271857abcdc7c66c9f0e085815c10de36184729ab84`); stop the schedule first.
2. Merge and deploy the code. No new environment variables: it reuses
   `META_*`, `INSTAGRAM_TOKEN_ENCRYPTION_KEY*` and `CRON_SECRET`.
3. Keep the corrected existing Production renewal job unchanged. Its direct
   `net.http_post` command reads `voom_instagram_cron_secret` from Vault; do not
   reference a custom worker helper or paste a bare `cron.schedule` over it.
   For any separately approved missing installation, follow
   [the guarded scheduling runbook](scheduled-workers.md): compare the inventory,
   authorize only the exact missing job name and preserve all other jobs. The ops
   file now rejects unexpected definitions rather than replacing them; it is not
   executed by deployment or migration. No worker needs manually triggering.

4. Verify after the first run: the worker returns `renewed: 1` for the
   existing connection, and Channels shows a new expiry about 60 days out.
