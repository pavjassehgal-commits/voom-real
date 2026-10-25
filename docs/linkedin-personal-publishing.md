# LinkedIn personal-profile text publishing (Phase 1)

Local implementation only. No credentials, migration application, deployment,
cron registration or real LinkedIn calls are part of this change.

## Architecture and limits

- Reuses `mara_drafts`, its 0059 content-version/approval state machine,
  `content_calendar_items`, and `mara_tool_runs` auditing. The manual LinkedIn
  workspace is `/app/linkedin`, linked from Connections.
- Adds a provider-specific durable queue like Instagram/TikTok/YouTube. It does
  not place LinkedIn work in another provider's queue or alter their workers.
- Phase 1 is explicit owner approval only. LinkedIn is deliberately NOT added
  to the automatic MARA campaign/channel-generation allowlist. Manual approvals
  remain effective when automation is paused, as with existing manual work.
- Personal profile only, text only, public visibility (clearly disclosed before
  approval). No images, videos, Company Pages, analytics, paid generation or billing.
- Tokens use the existing AES-256-GCM vault pattern with a separate LinkedIn key
  and owner-bound authenticated data. Secret rows and OAuth state have no browser
  read/write grants. Connection and queue reads have owner RLS.
- OAuth uses server-side authorization-code exchange and `userinfo` with that
  token. No unverified ID-token claims or browser-provided identity are trusted.
  State is hashed, ten-minute, owner/business-bound, cookie-bound and single-use.
  Disconnect invalidates even already-consumed states waiting on token exchange.
- A profile already bound to another VOOM owner cannot be overwritten. Same-owner
  reconnect preserves its connection identity. Disconnect is required to switch
  profiles; old jobs retain their original member binding and cannot cross-post.
- Local disconnect deletes encrypted credentials, clears the active binding and
  cancels unsubmitted jobs. It does not claim remote revocation; users may remove
  VOOM under LinkedIn's permitted services. Submitted/published history is retained.

## Queue reliability

1. Save a draft. Saving does not approve, enqueue or call LinkedIn.
2. Explicitly approve the displayed saved version, account and send time. SQL
   verifies owner/version/account, records approval, mirrors the calendar and
   upserts one queue row per owner/draft in one transaction.
3. The protected worker atomically claims due jobs (`FOR UPDATE SKIP LOCKED`).
   Immediately before submission it rechecks the approved content version, exact
   text, approved send time, `approval_origin=user`, connection/member and expiry.
4. Published requires HTTP 201 plus the returned `x-restli-id` post URN. Queue
   state and `mara_drafts.provider_ref` are then saved atomically. There is no
   claim of read-back, analytics or engagement verification with write-only scope.
5. Explicit rate-limit rejection (429) and pre-submission failures can retry,
   at most five claims, with fifteen-minute backoff. The approved schedule is
   unchanged by retry backoff. Expired/401 authorization needs reconnect and
   another explicit approval; reconnect never automatically restores jobs.
6. A timed-out POST, 5xx, missing publication reference, or stale submitting lease
   is `uncertain`: never resend automatically. A failed completion write leaves
   the job submitting and eventually uncertain. Check LinkedIn manually before
   any separate follow-up. There is no guaranteed provider-side exactly-once key.
7. Claimed/submitting/uncertain/published drafts cannot be edited or re-queued.
   Unclaimed edits/rejection invalidate approval and cancel the queue row.

## Migration — do not apply automatically

`0062_linkedin_personal.sql` requires the existing migrations through 0059;
0061 can precede it but no AI-usage objects are used. 0060 on TikTok Sandbox is
unrelated. Check remote migration numbering again before release.

It adds four tables (connections, encrypted secrets, OAuth states and publishing
queue), owner-read RLS, server-only RPCs and a LinkedIn-specific draft-edit guard.
It extends existing draft/calendar vocabulary checks without changing their old
expressions or existing records. It does not replace existing provider functions
or register any cron. A staging schema preflight and rollback plan are required
before applying it. Do not use a generic Preview that inherits production secrets.

## Developer Portal prerequisites for isolated real testing

1. Confirm the correct VOOM app owner/LinkedIn Page; reuse an existing appropriate
   app if one exists. Do not create a duplicate app automatically.
2. Enable **Share on LinkedIn** and **Sign In with LinkedIn using OpenID Connect**.
   Confirm the Auth tab grants `openid`, `profile`, `w_member_social`.
   VOOM does not request email, member-read, organization or advertising scopes.
3. Register the exact HTTPS callback for the isolated test host:
   `https://<isolated-host>/api/integrations/linkedin/callback`.
   Later production uses `https://voom.today/api/integrations/linkedin/callback`.
4. Configure server-only values in that isolated environment, not generic Preview:
   `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_REDIRECT_URI`,
   `LINKEDIN_TOKEN_ENCRYPTION_KEY` (new random secret, at least 32 characters),
   `LINKEDIN_API_VERSION` (currently documented version: `202610`).
   Keep staging Supabase separate; do not copy production tokens/credentials.
5. No programmatic refresh capability is assumed for the self-serve products.
   Respect returned token expiry and ask the owner to reconnect when needed.
6. Apply the reviewed migration only after separate approval and validate owner
   isolation in staging. Test OAuth first, then a specifically approved test post.
7. Only after successful real validation, explicitly configure an authenticated
   scheduler for `/api/cron/linkedin-publish` using existing `CRON_SECRET` practices.
   This change does NOT configure, enable or invoke that scheduler.

## Official references

- OAuth: https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow
- Identity: https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2
- Share product: https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin
- Posts: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
- Refresh availability: https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens

Company Pages remain Phase 2: Community Management access, appropriate Page roles,
organization scopes, business verification and LinkedIn's separate review process.
