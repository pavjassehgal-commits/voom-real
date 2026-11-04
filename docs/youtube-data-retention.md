# YouTube data erasure and retention — local release candidate

Branch: `codex/youtube-data-retention`, based on main `e322af0` (PR #98).
Migration: `0065_youtube_data_retention.sql`, installed once in isolated staging during acceptance below; NOT applied to Production.
No real accounts/tokens, existing customer records, Production data or Google settings were changed. Staging acceptance used disposable synthetic records, all removed afterward.

**Current integration addendum (October 31):** the active branch is
`codex/youtube-compliance-integration` on main `9043131`. The historical evidence
below describes 0065. New local-only forward migration **0069** and the disabled
delivery adapter add mandatory independent intent/completion receipts and failure
alerts. Missing capture blocks access and leaves erasure pending; SQL account
deletion must stage/capture first. No destination or remote migration is configured.
See `youtube-deletion-delivery.md` and `youtube-compliance-release.md`; those
requirements supersede earlier immediate-erasure descriptions below. eSmart
operational/legal approval and hosted integration acceptance remain outstanding.

## Policy basis and boundary

Official policies checked 30 October 2026:

- https://developers.google.com/youtube/terms/developer-policies — III.A (disclosures), III.D.2 (revocation), III.E.4 (stored data and deletion).
- https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke — programmatic revocation.

The detailed YouTube policy requires deletion within seven calendar days for in-app consent withdrawal and user data/account deletion requests. Google-side revocation and authorization validation have separate thirty-day obligations. This implementation deletes live API data immediately when withdrawal/invalid authorization is known and uses a conservative 28-day expiry where validation fails. It does not equate a timeout, network outage or 5xx with revoked consent.

This is not a legal opinion or certification. Operator identity, infrastructure backups, restore procedures and deletion-request staffing must be confirmed before public compliance claims or verification submission.

## Existing flows audited

- `DELETE /api/integrations/youtube/disconnect`: previously removed local credentials, best-effort revoked at Google, but retained channel identity, queue history and metrics. Now performs durable erasure and a leased revocation retry.
- Google revocation: no authenticated Google push/revocation webhook was present. The common credential path now handles confirmed invalid authorization with erasure; the existing reconciliation cron also checks idle connected accounts. No new webhook or scheduled job is invented.
- Account deletion: no customer self-service full-account deletion route was found. The existing public instructions use verified email requests. A YouTube-only `BEFORE DELETE ON auth.users` trigger now purges API-derived history before FK cascades and queues Google revocation. It does not implement a global account-deletion product or change other providers' guards.
- Data deletion requests: still accepted through the monitored account email. An owner-authenticated, same-origin `DELETE /api/integrations/youtube/data` requires the exact body `{"confirmation":"DELETE YOUTUBE DATA"}`; body-supplied owner IDs are rejected. An authorized operator can use the same server-only functions after verifying an emailed request. No admin bypass exists for ordinary browser users.

## Stored-data inventory

| Record | YouTube-derived/sensitive fields | Erasure behavior |
| --- | --- | --- |
| `youtube_connections` | Channel ID/title/handle/thumbnail, granted scopes, token expiry, provider connection metadata | Delete owner's row, including cached identity |
| `youtube_connection_secrets` | AES-GCM access/refresh ciphertext and key metadata | Remove from publishing immediately; at most one refresh ciphertext may be isolated for revocation |
| `youtube_oauth_states` | Hashed authorization state and consent timing | Delete owner's states; ordinary expired states are pruned |
| `youtube_publish_queue` | Resumable session URLs, returned video IDs, upload/processing/privacy/rejection evidence, provider notes and attempts; also copies of user-authored metadata | Delete owner's entire queue, including published history, after retaining only local duplicate-prevention identity |
| `youtube_performance_snapshots` | Returned video IDs and dated views/likes/comments/source data | Delete owner's snapshots; otherwise expire after 28 days |
| `mara_drafts.provider_ref` for `youtube_video` / `youtube_short` | Returned YouTube video ID | Clear only those provider references; withdraw prior YouTube approval |
| `youtube_revocation_tasks` (new, server-only) | Minimal encrypted refresh credential for a pending Google revocation | Leased retry; delete on confirmed revoke/already-invalid token; destroy ciphertext after six days and report expiration |
| `youtube_privacy_controls` (new, server-only) | Voom owner/action timing, erasure barrier and request/completion timestamps; no Google IDs | Keep minimal control state while Voom account exists |
| `youtube_erased_publications` (new, server-only) | Voom owner + draft UUID only, never video/channel IDs or provider URLs | Prevent erased/uncertain uploads from becoming fresh submissions; cascade on Voom draft/account deletion |

Campaign/content views assemble provider evidence from the queue or `provider_ref`, rather than a separate persisted YouTube-ID cache in the inspected paths. Private user-uploaded MP4s, AI-generated media, captions, scripts, hashtags, proposed times, marketing plans, credit ledger and other platforms are NOT erased by YouTube disconnection. Old approvals are withdrawn. A previously attempted draft cannot be resubmitted automatically after its evidence was erased; a deliberate new publication requires a new draft and approval.

Support emails, user-supplied text containing a copied provider link, platform-hosted videos, infrastructure logs and backups are not claimed to be purged by this database routine. Their applicable deletion/retention handling needs the operational process below. No Google video-delete endpoint is called.

## Security and reliability

- No new table permits browser access; all maintenance/destructive RPCs are service-role-only with an empty search path. The HTTP erasure route derives the owner from the authenticated session, validates Origin and rejects owner injection.
- The server first commits a small durable block, then executes transactional erasure. If the purge fails, access remains blocked and the existing maintenance run retries it. Request/completion timestamps expose overdue or late work.
- Published-row immutability stays enforced outside the narrow erasure transaction. There is no browser-settable bypass/GUC. Completion and erasure now both use draft-before-queue locking.
- New queue/snapshot/credential writes cannot recreate erased data. Fresh post-erasure OAuth must prove a newly consumed, owner-bound state; pending erasure/revocation blocks reconnect. A unique authorization epoch prevents a late old response or refresh from destroying/overwriting a replacement grant.
- Provider clients check the current grant before AND after each method, including subsequent upload chunks, status polls and upload-recovery reads. Confirmed provider authorization failures erase only the matching grant. In-flight HTTP already sent to Google cannot be recalled: it may finish there, but stale results are discarded and no new call is allowed from that cached client.
- Google revocation is isolated from publishing, leased and durable. Failed requests do not return credentials to the connection vault. HTTP 400 `invalid_token` means already-invalid, not an endless retry. Provider bodies/tokens are not logged.
- Existing `/api/cron/youtube-reconcile` Bearer authentication is retained. It runs maintenance before existing reconciliation, within the shared time budget. No Vercel/Supabase cron definition is added or changed. Maintenance checks two due idle connections and two revocations per invocation, and prunes bounded owner/evidence batches; validate capacity against real account count.
- The endpoint returns a generic error if retention cannot safely run. Expired revocations/overdue work produce a 503 operator-attention health status after unrelated owners' reconciliation still runs, not a global publishing freeze. Expired/overdue/late counts are available through the private backlog RPC. Operators must monitor failures; code alone cannot guarantee a deadline while infrastructure is offline.

## Required staging application and tests — separate approval

1. Confirm `voom-staging` / `qcdpegwjofrqnfudyrqq`, usable recovery point, reviewed migration hash and absence of partial 0065 installation. Never use a Production-connected Preview.
2. Confirm existing objects from 0047/0048/0046/0064 and complete functions match reviewed definitions; inspect workload/locks. 0065 adds three private tables, two connection columns/indexes, guards, a YouTube-only account-delete hook and server-only RPCs. It does not depend on TikTok migration 0060, create cron jobs, or delete existing rows at install. The UUID default on the new epoch column may rewrite/lock the small connection table; measure in staging. Before activating maintenance, explicitly inventory legacy connection/evidence ages: records already past the retention limit can be erased on the first run. Review the affected owners and notices; do not silently activate it against real accounts during this task.
3. Apply ONLY 0065 transactionally, not bulk `db push`. Verify ACLs/RLS, internal function revokes, the PostgREST schema reload, indexes, guard definitions, and unchanged business/media/credit/other-provider counts.
4. Deploy only to an isolated, protected, synthetic staging environment. Keep social/AI providers and publishing workers disabled. Test with disposable credentials answered by fakes, never a real connected customer or real YouTube call.
5. Exercise owner erasure, request failure then maintenance recovery, revocation failures/leases/expiry, wrong-owner requests, idle invalid authorization, fresh reconnect, stale refresh/provider responses, deleted-history duplicate blocking, account-delete cascades, and old evidence expiry. Verify native video media and credit records survive.
6. Run independent PostgreSQL sessions for erasure vs queue claim/completion, snapshot insert/upsert, refresh and OAuth replacement. Embedded PGlite tests cover actual SQL and controlled late results, but do NOT prove multi-session lock behavior. Force a purge timeout and verify the committed barrier plus next-run recovery.
7. Remove synthetic fixtures using the test transaction rollback/approved fixture cleanup. Compare existing TikTok/Instagram/LinkedIn records and cron inventory. Do not run publishing endpoints.

## Operational/legal release blockers

- Coordinate migration and application rollout. Installation does not erase rows by itself, but it changes existing disconnect/status RPC behavior: old application calls can invoke erasure while the old disconnect dialog still promises retained history. Reconnection after erasure also requires the updated callback's owner-bound state proof. Validate migration-first compatibility in staging and use an approved coordinated rollout/maintenance window if needed; do not leave old code running indefinitely against the new behavior.
- Identify the actual legal operator/data controller and appropriate business contact with the owner/counsel. Do not invent an entity, address or governing jurisdiction.
- Confirm Supabase backups/PITR/export copies, logs and any external storage copies have a documented YouTube-data retention and secure deletion process. Keep deletion-request records outside restorable application backups; after a restore, isolate workers and replay verified erasures BEFORE any access or publishing resumes. This repository change cannot delete managed backup snapshots or guarantee their expiry.
- Approve and staff the email request process: record receipt, promptly verify ownership without restarting the seven-day deadline indefinitely, execute the owner-scoped routine, verify the purge, and confirm completion. For full account deletion, verify other providers' existing cascade/terminal guards; do not bypass those guards to finish a YouTube-only request.
- Monitor the existing reconciliation cron and private backlog, account for outage/batch capacity, alert well before seven days, and verify revoked/idle-account checks run at least within the 28-day cap. An expired revocation task has no credential left and deliberately blocks reconnect until an authorized operator verifies independent Google revocation and resolves that task; do not clear it blindly.
- The revocation task's expiry is six days, leaving an operational margin before the seven-day maximum; worker availability and early alerting remain mandatory. Do not let a backup restore reintroduce expired ciphertext.
- Review existing AI-processing disclosures separately before claiming Google-derived data is never transferred to AI services; this change does not introduce such transfers or certify an app-wide data-flow audit.
- The policy pages describe the candidate's live-data behavior, not completion of the above operational gates. Their publication must wait for these checks. No promise of Google OAuth approval or public-upload eligibility is made.

## Rollback/recovery considerations

No automatic rollback. Erasure cannot be undone by restoring deleted API data from backups. Prefer a forward fix that preserves privacy blocks and tombstones. Dropping the new controls/outbox while requests exist would remove duplicate protection or lose revocation work and is unsafe. Any schema rollback requires separate approval, zero pending requests/revocations, and deliberate restoration of the old function definitions/ACLs; the old retention behavior is not production-compliant merely because it runs.

## Google Branding values kept ready (not configured)

- Name: `Voom`; homepage: `https://voom.today/`.
- Privacy: `https://voom.today/privacy`; Terms: `https://voom.today/terms`.
- Authorized domain: existing `voom.today`; verify Search Console ownership separately.
- Existing support/developer contact: `pavjassehgal@gmail.com`.
- Official square, white-background logo: `/Users/pavjassingh/Desktop/VOOM-TikTok-App-Icon/voom-tiktok-app-icon-1024.png` (80,721 bytes, 1024 × 1024). Google recommends 120 × 120 and accepts square PNG under 1 MB. No logo or Branding settings were changed.

## Local verification — 30 October 2026

- Focused YouTube privacy, provider, native upload, OAuth/reconnect, refresh-diagnostic, legal-page, Instagram security and plan/credit suites: **205 passed, 0 failed**. Database tests use actual migration SQL in isolated embedded PostgreSQL (PGlite), not live staging or Production. Independent-session lock testing remains a staging gate.
- TypeScript and changed-file lint (`--max-warnings=0`): passed. `git diff --check`: passed.
- Production build: passed using Next.js's supported Webpack builder and synthetic environment values. Default Turbopack cannot traverse this worktree's existing external `node_modules` symlink; no product/dependency change was made to hide that environment limitation. Public Google Fonts retrieval required network access; no live provider credentials were supplied.
- Migration SHA-256: `2f612e4070dc2ed95d0fcbc463fe56dfe9d0618c806259f00a8002964de0a1f5`.
- No commits, pushes, merges, deployments, real provider calls, database migration applications or real user-data deletions were performed.

## Staging acceptance — 30 October 2026

This section supersedes the local-only migration status above; the earlier local checks made no database changes.

- Positively verified Management API identity: `voom-staging`, `qcdpegwjofrqnfudyrqq`, `ACTIVE_HEALTHY`, database host `db.qcdpegwjofrqnfudyrqq.supabase.co`. No Production endpoint was requested. Existing local CLI project metadata also matched staging, but was not used as the sole identity proof.
- All 0065 objects were absent. Every inspected pre-0065 YouTube/approval function body and security configuration matched the local migration baseline. No blocked/long-running sessions, existing YouTube connections or publishing jobs were present. A completed staging backup dated `2026-10-29T20:38:38.558Z` was available (PITR disabled); no recovery was needed or attempted.
- Applied the complete, unchanged, transaction-wrapped 0065 exactly once, SHA-256 `2f612e4070dc2ed95d0fcbc463fe56dfe9d0618c806259f00a8002964de0a1f5`. Execution took approximately 1.25 seconds with short statement/lock timeouts. It is a one-time migration, NOT a rerunnable installer; erasure/retry operations themselves are idempotent.
- Verified three private RLS tables, two connection columns, six relevant indexes, five enabled triggers and nine validated new-table constraints. All 29 installed YouTube function bodies/security settings matched the locally tested definitions. Browser roles cannot invoke server RPCs/read private tables; internal token/save functions remain inaccessible to service-role callers, and revocation ciphertext remains RPC-only.
- **21 synthetic staging acceptance checks passed**, including seven paired tests with confirmed distinct live PostgreSQL backend PIDs: simultaneous disconnects, request/disconnect, token refresh/disconnect, worker completion/disconnect, queue claim/disconnect, committed erasure/late worker response, and concurrent revocation claims. Other checks covered idempotency, owner RLS, published-record completion without an external upload, wrong lease acknowledgements, retry backoff, ciphertext expiry, account deletion, 28-day retention, overdue request reporting without deadline extension, replacement-grant protection, owner-bound fresh consent, and post-reconnect duplicate/snapshot barriers.
- An independently held draft lock deliberately caused a purge timeout AFTER the synthetic owner's request barrier committed. Access remained blocked; bounded maintenance recovered the deletion. These operations targeted synthetic owners only; no real Google token was loaded or revoked.
- Committed fixture accounts had no passwords and used `example.invalid` addresses. Their credentials were invalid synthetic strings, not usable Google tokens. Committed queues were cancelled and dated 2100; claimable/processing changes existed only inside rollback transactions. No storage objects, cron endpoints, real publishing workers or external providers were invoked.
- Existing drafts/media metadata, settled credits, other-owner data and unrelated social-platform data passed preservation checks. After exact fixture cleanup, the pre-test row counts AND row fingerprints for all 21 monitored existing data tables matched; cron definitions, existing policies/default grants and RLS settings were unchanged. All three new tables and synthetic auth fixtures were empty, with no blocked sessions remaining.
- Focused deterministic regression suites rerun: **205 passed, 0 failed**. TypeScript passed. Policy/deletion copy tests passed; no policy page or application deployment was performed. Multi-session PostgreSQL testing is now completed for the above cases, replacing that earlier staging gate; operational/legal and coordinated-rollout gates still apply.
- The first concurrency-harness attempt stopped because PostgreSQL truncated an overlong test session label; fixtures were removed and baseline preservation verified. A read-only two-session check confirmed API concurrency, then a shorter label resolved the harness issue. No product-code change, migration retry or isolation bypass was needed.

Protected evidence and reproducible test harnesses for this acceptance are local at `/private/tmp/voom-0065-staging-evidence/`, `/private/tmp/voom-0065-staging.py`, `/private/tmp/voom-0065-concurrency.py` and `/private/tmp/voom-0065-extra.py`. Evidence excludes token plaintext/customer content. No commit, push, merge or deployment occurred. Production release remains subject to the operational/legal sign-off and coordinated migration/application rollout described above.
