# VOOM Approval Safety — Staging candidate and validation plan

24 November 2026, Dubai. Local preparation only. Claude's Step 1B verdict was READY FOR STAGING; this document records the small subsequent cancellation fix and the staging gates. It is not evidence that staging was performed or authorization to change a hosted environment.

## Step 1D — Final Autopilot cancellation guard

This correction follows reviewed commit `47f9e457dab00dfb5da494c1558913db7c0bf2b4` on the same branch. The commit containing this section is the new local candidate; earlier Step 1C details below are historical.

The terminal-row reopening UPDATE in `approve_reviewed_post` now requires `p_origin = 'user'`. Autopilot can no longer reopen a Pause-all cancellation (or reopen an expired terminal row through this UPDATE). Approval behavior outside this UPDATE is unchanged. Provider-owned/published state, exact reviewed version, ownership, media and future-schedule guards remain in place.

A real SQL regression first failed against the reviewed migration, then passed with the guard. For both draft and already-approved items it exercises repeated Autopilot approval followed by ordinary and reviewed queue synchronization; the complete cancelled queue row stays unchanged. The owner test rejects a stale version, then verifies correct reviewed approval schedules the same queue identity without provider IDs. These are embedded PostgreSQL tests, not hosted or multi-session testing.

Step 1D validation: **261 focused tests passed, zero failed/skipped**; TypeScript passed; lint zero errors /16 warnings. Full suite was not rerun for this minimal correction. Staging must additionally exercise Autopilot after Pause all and verify no queue reopening before a fresh explicit owner approval. Existing migration-first fencing, rollback sequence and all unexecuted staging gates below still apply. No hosted SQL, deployment or publishing occurred.

## Candidate and change since review

Branch `codex/approval-safety-569f27c`, based on Production `569f27c74e247a3568fdbb089cf39c0ed71fdb0a`. The local commit containing this file identifies the complete candidate; obtain its SHA with `git rev-parse HEAD`. No push, merge, deploy, hosted migration or live publishing was performed.

The reviewed reschedule SQL could turn a cancelled queue row into `failed / owner_rescheduled_sync_required`; subsequent synchronization could rearm it. Step 1C now rejects non-null reschedules if any owned Instagram, TikTok or YouTube queue is cancelled, under the same queue locks and before any draft change. This also applies to the legacy three-argument RPC and the reviewed Instagram Post now wrapper. Unscheduling remains allowed but leaves the full cancelled row unchanged. Other unclaimed jobs still park atomically before normal synchronization.

The error `approval_queue_cancelled` explains that changing time does not resume publishing. Post, Plan and native video paths direct the owner to review and explicitly approve through the existing editor. Only that new explicit approval can authorize reactivation; TikTok still requires its native consent sheet, and YouTube requires its own declarations and approval. A reschedule request, synchronization call, retry or Post now shortcut is insufficient. No new reactivation endpoint or publishing path was added.

Step 1C implementation/test files:

- `supabase/migrations/0080_approval_safety.sql`
- `lib/post/approval-safety.ts`
- `lib/social/server-drafts.ts`
- `app/api/social-drafts/[id]/route.ts`
- `lib/voom/workflow/actions-server.ts`
- `tests/approval-safety-review.test.mjs`
- `tests/native-approval-review.test.mjs`

Documentation updates are this plan, `docs/approval-safety-review-followup.md`, `ARCHITECTURE.md`, `DECISIONS.md` and `handover/next-session.md`. The rollback SQL is unchanged since Step 1B. The historical Step 1B report records its then-current migration checksum; use the current Step 1D checksum below for this candidate.

## Non-negotiable expiry and recovery rules

New schedule choices require at least 60 seconds of future lead, checked again by database time. Instagram's automatic window ends exactly 20 minutes after the approved draft schedule; retries do not move that deadline.

An expired job with a provider container, an in-flight submission or an uncertain provider outcome must never be automatically recreated, republished or assigned a fresh provider identity. Claiming a container-bearing expired failure is permitted only for bounded read-only reconciliation by the new worker. It is not a publishing retry.

Safe owner recovery:

1. Keep the queue identity, container/media IDs, timestamps, failure and submission history. Do not delete the queue, clear provider IDs, change it to scheduled or clone it as a retry.
2. Let the new worker query existing provider status only. If the provider confirms publication, record that truth in the original item and stop. Discovery after the deadline does not justify changing published history.
3. If status is processing, unavailable, failed or otherwise inconclusive, leave the item blocked. Check Instagram directly and record the outcome during an authorized operational investigation. Attempts remain bounded; lack of confirmation is not proof that nothing published.
4. Existing UI reschedule/Post now RPCs refuse provider-owned rows. There is no automatic or routine editor override for an expired submitted item. If a replacement is desired, the owner must first resolve the external outcome and separately authorize a new reviewed post through the normal platform flow. Never create a replacement solely because a timeout occurred. Any exceptional administrative reconciliation is a separate reviewed operation, not part of this release.
5. Only expired jobs with no provider submission can use the existing reviewed reschedule or fresh explicit approval recovery. Cancelled jobs additionally require fresh explicit approval. No content is silently discarded.

A provider request sent within the window can complete later; no database policy can retract that external request. Reconciliation must preserve actual provider publication, not falsely mark it cancelled or retry it.

## Prerequisites for authorized staging

- Separate permission for hosted staging changes. This task grants none.
- Identify and record the staging database/project, app deployment, worker scheduler and exact local candidate SHA. Confirm none points at Production. Check current migration ledger and actual definitions; a previously applied candidate numbered 0080 must not be assumed identical.
- Use a disposable PostgreSQL database or approved isolated staging project with synthetic data only, two synthetic owners, valid business timezones, and separate normal-user/service-role sessions. Record PostgreSQL version and candidate checksums. Do not copy customer content or credentials.
- Provide real PostgreSQL connections (at least two independent psql connections, not one pooled transaction, PGlite instance or sequential requests). Confirm the ability to inspect test locks and recover blocked sessions.
- Provide isolated browser sessions and test authentication for both owners. Use provider doubles/network interception for all upload, container creation and publish requests. Keep real social tokens absent and reject outbound publish calls at the test boundary. TikTok/YouTube editor consent must still be exercised; a fake provider must not bypass application validation.
- Disable scheduled publisher invocations and direct/manual worker calls for this test environment before any migration. Inventory all schedulers and older deployments. Do not assume a feature flag exists: `/api/cron/instagram-publish` uses CRON_SECRET authentication, not a dedicated worker-enabled switch. Arrange an authorized scheduler/ingress fence and verify it with logs. Do not rotate shared credentials or pause customer work as part of preparation.
- Keep a migration/schema backup and synthetic record snapshots; retain before/after function definitions and grants for rollback comparison. Snapshot rows before worker execution separately from migration execution.

## Real concurrent PostgreSQL validation

Run each case with independent Session A and Session B and reverse the winner. Use synthetic owned draft/queue/action IDs and exact versions from a fixture manifest. Record timestamps, transaction isolation, backend PIDs, blocking relationships, return values and final rows. Use bounded local lock/statement timeouts; intentional blocking is not a pass by itself. Serialize cleanup only after both sessions finish. A deadlock that aborts a request must fail closed, leave consistent data and surface a retryable conflict; no transaction may enqueue unreviewed content.

Practical blocking procedure (psql, fixture IDs supplied by the test operator):

```sql
-- Session A, test database only
begin;
set local lock_timeout = '10s';
set local statement_timeout = '30s';
select pg_backend_pid();
select id from public.mara_drafts where id = :'draft_id'::uuid for update;
-- Keep this transaction open while B starts the reviewed RPC.
-- Change content or withdraw approval using the fixture's intended operation,
-- then COMMIT. B must observe the committed version/state and reject.
```

Session B starts its own transaction with the same timeouts and calls `reschedule_reviewed_draft(owner, draft, reviewed_version, future_time)` or the actual approval RPC signature from 0080. After A commits, capture the result and explicitly roll back B on an error. For the reverse ordering, A executes the RPC first and holds its transaction open; B attempts the edit/cancellation, then A commits. Verify final approval versions, cancelled queue state and absence of claimable withdrawn content. Also exercise the real HTTP paths: manually locking a row alone does not cover all application lock ordering.

| Case | Required result and evidence |
|---|---|
| Reviewed approval vs content/media edit | Stale review conflicts; an edit after approval withdraws it and unclaimed work. No publish request for changed content. |
| Two confirmations of the same pending/campaign action | One decision, no duplicate queue identity or side effect; loser is an accurate conflict/idempotent result as appropriate. |
| Cancellation/Pause all vs reschedule, approval, queue sync | Ordinary reschedule cannot undo cancellation. If cancellation commits last it remains cancelled. Explicit later approval must be visibly authorized and versioned. |
| Reschedule vs old-time claim | Worker cannot claim the old due time after new schedule commits; parked rows remain unclaimable until metadata sync. |
| Two simultaneous claimers | FOR UPDATE SKIP LOCKED prevents duplicate active ownership; no duplicate provider write. |
| Expiry/retry vs cancel/withdraw/sync | No cancelled or withdrawn job rearms. Retry clock cannot extend deadline. Provider IDs never reset. |
| Approval vs campaign/card supersession | Superseded, cancelled or skipped action cannot confirm; browser version is never substituted. |
| Cross-owner and direct client SQL | Wrong owner cannot read/write/confirm; anon/authenticated cannot call service-only helpers. Use actual roles/JWT claims, not a superuser RLS simulation. |

Run repeated interleavings for contention cases with barriers, not sleeps alone. Inspect lock timeouts/deadlocks and leaked transactions. Store redacted results alongside candidate SHA. No real simultaneous-session test has been performed locally in Step 1B/1C.

## Browser approval and consent journeys

| Journey | Required checks |
|---|---|
| Post Editor, Plan, Approvals, campaign Instagram approval | Open item in browser A, edit caption/media/schedule in B, then confirm in A. Require conflict and renewed review. Test unchanged approval, repeated clicks, cancelled/withdrawn/superseded cards and a second owner. |
| Create schedule then approve | Save a future business-local time, confirm only the resulting version and show Scheduled only after queue verification. Inject a concurrent edit between save/approve and a failed sync; neither may show false success. |
| Timezones and expired approvals | Dubai, New York (DST edges), Auckland and browser zone different from business. Test past time, +59 seconds, database +60-second boundary, invalid zone, old September card and time expiring while open. UI explains future-time recovery without implicit Post now. |
| Cancelled item reschedule | For Instagram/TikTok/YouTube, cancel/Pause all while draft remains approved. Change time and use Plan Post now: reject, preserve queue/history, clear explanation. Unschedule preserves cancellation. Fresh explicit platform approval is the only resume action. |
| TikTok | Playable preview, current creator/privacy options, manual privacy/interaction/commercial/AI/music declarations and explicit per-post consent. Edit media/caption or submit stale version after opening sheet: consent cannot attach to newer content. Generic approve card hands off, never posts. No real upload. |
| YouTube | Preview, explicit audience/privacy/synthetic declarations and current reviewed version. Ordinary reschedule preserves declarations but cannot resume cancellation. Missing/stale approval or changed video fails closed. No real upload. |
| Legacy MARA cards | Seed supported non-Instagram cards, including ones lacking old version metadata. Native editor link is correct; generic confirmation unavailable. Email/planning explanations accurate and no send/publish API invoked. |
| LinkedIn and existing safeguards | Verify editor handoff, owner-only review and explicit publish control remain intact. No automatic publish or live request. |

Capture screenshots, requests/responses, versions and synthetic queue/calendar/action rows before/after. Do not label these completed until actually run.

## Instagram worker, retry and recovery matrix

Run the real claim SQL plus the new application worker with provider doubles. Record count and type of external calls; only GET/status reads are allowed for expired provider-owned work.

- Approved schedule +5 minutes: eligible; exactly one normal publish sequence with current content/version.
- Approved schedule +19:59.999 versus exactly +20 minutes: boundary behavior, including expiry during readiness polling and immediately before publish.
- Hours/days late, retry time moved tomorrow, missing/invalid schedule, waiting_for_media and permission_required: no automatic publish; accurate terminal failure and content retained.
- Retry planned beyond cutoff, stale claim lease, worker crash after container persistence and timeout after uncertain media_publish: no new container or publish after expiry; preserve provider identity.
- Existing container reports PUBLISHED: read-only reconciliation records original publication. Processing/error/unknown or unavailable provider: remains blocked, bounded recovery, no blind resend.
- Ordinary queue upsert, not-approved repair, calendar mirror sync, reapproval/reschedule and concurrent cancellation: no alternate resurrection of expired submitted/withdrawn/cancelled work.
- Published fixtures remain unchanged by expiry, retry and reschedule attempts. Queue counts and calendar/Plan/Today states reflect outcomes after refresh; no invented success.

## Migration, compatibility window and rollback drill

**The SQL-first compatibility window is a controlled maintenance interval, not unrestricted mixed-version operation.** Existing RPC signatures remain, but older workers do not enforce the new expired-container read-only behavior, and old app callers may not understand new errors or version requirements. Applying SQL alone does not establish complete safety.

Authorized sequence:

1. Verify the target and candidate SHA/checksums, backup function definitions/grants and fixture rows. Fence approval/schedule writes and *all* publisher invocations, including cron, manual calls and old deployment URLs. Keep unrelated services unchanged. Drain existing requests/workers (Instagram route ceiling is 300 seconds; use observed invocation completion and lease/provider state, not elapsed time alone). Already-accepted external requests may still finish.
2. Apply migration 0080 transactionally **before** dependent app code. Check helper existence, execute grants, replaced function bodies and schema compatibility. Older app read views can remain available; do not permit mutations/worker traffic during this gap. If reliable fencing is unavailable, stop the rollout.
3. Deploy the exact candidate app while fences remain. Confirm all traffic and schedulers target the new version; no old worker invocation is still active. Run non-publishing smoke checks and the validation matrix in isolated staging. Reconcile uncertain provider-owned fixtures read-only.
4. Re-enable only the intended new-version paths after gates pass and explicit authorization covers activation. Never resume the old worker against new SQL. Record the maintenance window and observed outcomes.

Rollback drill on a disposable copy, including a failed deployment between steps 2 and 3:

1. Keep writes and workers fenced. Revert dependent application code **before** database rollback; drain every invocation using new helpers.
2. Run `supabase/rollbacks/0080_approval_safety.sql` transactionally. It restores baseline definitions and removes only new helpers; no executed customer-row mutation or CASCADE. Compare actual pre-migration function definitions/grants and row snapshots. Benign whitespace differences are not semantic mismatches, but investigate all differences.
3. Verify pending/confirmed/rejected approvals, cancelled/expired jobs, provider-owned and published records survive unchanged by rollback. Reapply 0080 on the disposable copy and rerun representative checks. Capture failure/transaction-abort behavior as well as success.
4. Baseline rollback restores the old missing-lateness behavior. **Do not automatically resume baseline publishers** after rollback. Keep unsafe work fenced pending an explicit operational decision. Rollback is not a fix for late publishing.

No script changes customer data during rollback itself, but old code can behave differently afterward. Do not confuse definition-only rollback safety with safe unrestricted baseline operation. If an older 0080 candidate is already installed, stop and design an authorized migration-forward path instead of editing an applied migration silently.

## Local validation and remaining gates

Step 1C focused suite: **260 passed, zero failed, zero skipped**, adding cancelled reschedule tests for all three queues, no-change unscheduling, explicit reviewed Instagram reapproval, and native HTTP cancellation explanations. TypeScript (`npm run typecheck`) passes; lint (`npm run lint`) reports zero errors and 16 existing warnings; `git diff --check` passes. Step 1B full suite was 2587 pass /70 fail /5 skipped against baseline 2528 pass /71 fail /5 skipped, no new failing test names. The full suite was not rerun for Step 1C; targeted regression coverage was expanded and rerun.

No live browser journey, real multi-session PostgreSQL contention, hosted migration/rollback, provider call or staging deployment has occurred here. Independent review of the small cancellation delta and execution of this staging plan remain gates. Ready to stage under separate authorization; not a Production release approval.

Candidate migration SHA-256 (Step 1D): `a186c46be41cb3bc69ce8a361b8f52aad2c9be714c9c5f7276efe7d0119c8a87`.
Rollback SHA-256 (unchanged): `352bcb281990d59b7be747826b42b960215871b67a59c07d30f449490780565d`.
