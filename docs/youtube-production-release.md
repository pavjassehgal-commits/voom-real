# YouTube compliance — Production release order

Release branch: `fix/youtube-compliance-launch`. It contains the compliance code, migrations
0065 and 0069, the Cloudflare register, the Google verification wording and the policy pages.
Every step needs the owner's explicit approval. Nothing here has been run against Production.

## Gate 0 — before the release window (no customer impact)

1. **Approvals:** eSmart/legal sign-off of `/privacy`, `/terms` and `/data-deletion` as on the branch. Named primary and deputy alert recipients.
2. **Production register (Cloudflare Free):** run these in `workers/youtube-deletion-register`, then check them.
   ```bash
   npx wrangler d1 create voom-ydr-production
   ```
   Put the returned id in `[env.production]`, along with `ALERT_FROM`, `ALERT_TO` and `ALERT_ESCALATE_TO`.
   ```bash
   npx wrangler d1 execute voom-ydr-production --env production --remote --file schema/0001_register.sql
   ```
   ```bash
   npx wrangler deploy --env production
   ```
   ```bash
   npx wrangler secret put JOURNAL_TOKEN --env production
   ```
   Repeat the last command for `ALERT_TOKEN`, `REPLAY_TOKEN` and `RESEND_API_KEY` (a send-only key).
   Then check:
   - A request without a token gets 401.
   - `/v1/health` responds when called with the journal token.
   - The hourly watchdog has written its heartbeat.
   - **One approved real test alert**: post a synthetic alert and confirm both recipients receive the email.
3. **App:** open a PR from the release branch. CI, review and a production build must pass.

## Release window (one sitting, quiet hour)

The migrations and the app deploy must be completed together. After 0065 + 0069, the *old*
app's disconnect fails, because it can't record the independent deletion intent.
Customers stay blocked, not exposed, but the gap should be minutes, not days.

4. **Preflight (read-only).** Run `supabase/ops/youtube-compliance-preflight.sql` and confirm:
   - every `already_installed` is false;
   - every `prerequisites` is true;
   - `locks_on_youtube_tables` is 0.
   Record the `baseline`. Wait if `in_flight_uploads` is above 0.
5. **Apply 0065** in the SQL editor, byte-identical (SHA-256 `2f612e40…`). Run
   `supabase/ops/youtube-compliance-fingerprint.sql`, then
   `node scripts/youtube-register/verify-fingerprint.mjs 0065 result.json`. It must report
   0 unexpected differences.
6. **Apply 0069** (SHA-256 `a4ae6b3c…`), then run the same check with `0069`.
7. **Vercel Production env:** set these, then deploy the merged app:
   - `YOUTUBE_DELETION_DELIVERY_APPROVED=true`
   - `YOUTUBE_DELETION_JOURNAL_URL` and `YOUTUBE_DELETION_JOURNAL_TOKEN`
   - `YOUTUBE_DELETION_ALERT_URL` and `YOUTUBE_DELETION_ALERT_TOKEN`
   - `YOUTUBE_DELETION_FALLBACK_ALERT_TO`
   Change nothing else.
8. **After the first natural reconcile run** (it runs every 5 minutes):
   - The register shows a VOOM heartbeat.
   - `/v1/health` reports a fresh watchdog run.
   - Existing connected channels were **re-verified**: `authorization_checked_at` is set, and no unexpected deletion events exist. Maintenance now re-verifies before the 28-day sweep (regression-tested), so long-standing connections are not erased unverified.
   - No cron errors.
9. **Turn on the heartbeat requirement:** set `REQUIRE_VOOM_HEARTBEAT = "true"` for production and redeploy the Worker.
10. **Reconcile check:** `recover.mjs reconcile --approved` must report 0 missing records and 0 conflicts.
11. **Optional, approved:** with your test channel only, run Disconnect, then the data-deletion request, then Reconnect. This proves the real end-to-end flow before recording the Google demo.

## Rollback

- Migrations are forward-only, and erased YouTube data is **never** restored.
- If the app misbehaves, fix forward. Redeploying the previous app against the new SQL would leave disconnect failing.
- If the register is down, deletions stay blocked and pending (safe), and the fallback email fires. Repair the Worker; VOOM retries automatically.

## After release (Google)

1. In Google Auth Platform → Audience, switch the app from **Testing** to **In production**.
   - **Why:** in Testing, refresh tokens expire after 7 days. With this release that shows up as revoked access, which erases the test connection, and you'd have to reconnect weekly.
   - **What users see:** until Google verifies the app, they get the "unverified app" warning and a 100-user cap.
2. Submit branding verification, then record the demo (`docs/youtube-google-verification-package.md` §5) and submit data-access verification.
