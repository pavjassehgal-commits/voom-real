> Historical Step 1B results. Step 1C cancellation policy, current migration checksum and staging gates: [approval-safety-staging-plan.md](approval-safety-staging-plan.md).

# VOOM Step 1B — Independent review follow-up

24 November 2026, Dubai. **Implemented locally; ready for another independent code and SQL review. Not ready for Production release.**

## Branch and scope

- Branch: `codex/approval-safety-569f27c`.
- Base and current HEAD: `569f27c74e247a3568fdbb089cf39c0ed71fdb0a`.
- Checkout: `/Users/pavjassingh/Documents/GitHub/voom-real/.worktrees/approval-safety-569f27c`.
- All Step 1 and Step 1B changes remain uncommitted; no new commit SHA. Prior uncommitted work was preserved.
- No push, merge, deployment, hosted migration/database write, live publishing, paid generation, credentials/billing/account or Meta App Review changes. Separate Memory and Gurnoor checkouts were not edited by Step 1B.

## Confirmed causes and fixes

| Review finding | Confirmed cause | Implemented fix |
|---|---|---|
| Excessively late Instagram publication | Claim accepted every past-due time; retries and synchronization could move the queue timestamp without an upper bound. Worker checks did not share an approved-schedule deadline. | Explicit 20-minute grace from the draft's approved schedule. Claim expires overdue unsubmitted jobs; queue upsert and repair cannot revive them. Worker checks at load, before container creation, during polling and before publishing. Retry that reaches the deadline expires instead. |
| Expired or withdrawn work rearmed | Ordinary synchronization and retry could overwrite terminal state; schedule changes and metadata sync were separate. | SQL checks still-approved content and queue/provider state under locks. Explicit reviewed owner reschedule parks all unclaimed queues before releasing the schedule change, then ordinary sync updates metadata and rearms. Cancellation, withdrawal and provider ownership remain guarded. |
| TikTok/YouTube past scheduling | API tolerated five minutes in the past; canonical reschedule SQL lacked a future check. | Shared API policy and SQL require at least one minute of future lead. Rescheduling requires the displayed version and ownership; native declarations and consent remain authoritative. Schedule-only saves preserve existing metadata rather than normalizing it into a new content revision. |
| No 0080 rollback | Step 1 candidate lacked a matching reversal. | Added transactional definition-only rollback restoring the four replaced baseline functions and removing eleven new helpers. No customer-row updates or deletions execute during rollback. |
| Misleading legacy MARA cards | Retained legacy draft API and stored pending cards can represent non-Instagram kinds, but generic confirmation assumed Instagram and returned a misleading version/error message. | Owner-scoped kind resolution precedes generic confirmation. TikTok/YouTube link to `/app/content/{id}`, LinkedIn to `/app/linkedin?draft={id}`. Legacy email explains the limitation and points to Campaigns; planning/unsupported cards explain they cannot publish. Generic Confirm is unavailable for these cards. No alternate consent path. |

The earlier exact-reviewed-version approval mechanism remains in place for Campaigns, Post Editor, Marketing Plan, Approvals and Create. Create's save-then-approve handshake now has a dedicated tested helper: save compares the original version, approve uses only the expected resulting version, and success requires a verified scheduled queue. Plan reschedule/Post now carry the reviewed version. Post schedule-only save returns after versioned reschedule and synchronization rather than performing another stale write.

## Explicit time and recovery policy

- New scheduled choices must be valid instants at least **60 seconds in the future**. Exact 60 seconds is accepted at the checking boundary; later database validation can reject a time whose lead was consumed in transit. Business wall-clock input uses the authoritative business timezone; absolute instants are validated directly without rounding.
- Instagram automatic publication is allowed while `now < approved_schedule + 20 minutes`; at the exact cutoff it expires. Short worker delays remain supported. The queue retry timestamp never extends the approved deadline. SQL and TypeScript constants are regression-tested for parity.
- Expired unsubmitted jobs become `failed` with `instagram_schedule_expired`, keeping drafts, assets, calendar/history and queue identity. The message directs the owner to review and choose a future time or explicitly Post now through the reviewed owner boundary. No replacement time is chosen automatically.
- Existing provider containers/claims are not erased. After expiry, recovery may query provider status and record a confirmed earlier publication; it cannot create or publish. Recovery claims retain the existing attempt bound. If provider outcome is unresolved, the owner must inspect Instagram rather than blindly requeueing a possibly published item.
- Already-published records are excluded from expiry/retry mutation. A provider request accepted before the cutoff can finish afterward; the application cannot retract that external request. Later read-only reconciliation records provider truth.

## Migration and rollback safety

Candidate migration: `supabase/migrations/0080_approval_safety.sql`. Rollback: `supabase/rollbacks/0080_approval_safety.sql`. Neither was applied to a hosted database.

0080 extends the earlier six approval/calendar helpers with time-policy, expiry and reviewed-reschedule helpers. It replaces `claim_due_instagram_publish_jobs`, `upsert_instagram_publish_queue_item`, `fail_instagram_publish_job` and `reschedule_approved_draft`. New helpers are service-role only with an empty search path. Ownership, platform approval, version and provider-submission boundaries remain enforced.

Release order, only after separate authorization:

1. Independently review SQL against the actual target schema and review this complete uncommitted change set.
2. Apply 0080 **before** deploying dependent application code. Missing RPCs fail closed.
3. Verify queue expiry/recovery and native consent journeys in an authorized test environment before Production activation.

Rollback order:

1. Revert dependent application code first and allow in-flight dependent invocations to finish.
2. Then execute the reviewed SQL rollback. It restores original function bodies/grants and drops only 0080 helpers, without CASCADE. It does not requeue expired rows or alter approvals, cancelled work or published history.
3. Recognize that restoring baseline functions also restores baseline's missing lateness safeguard; rollback is a compatibility reversal, not a mitigation for the original bug.

PGlite tests compare function definitions and ACLs before/after rollback; assert all new helpers are removed; compare pending, approved, cancelled, expired and published fixture records unchanged; and reapply 0080 successfully. This is embedded PostgreSQL validation, not hosted execution or real multi-session contention testing. If an older 0080 candidate was applied to any separate environment, compare its actual definitions/checksum before a future authorized rollout; the migration number alone is insufficient.

SHA-256:

- Migration: `483e3894042fb5ed406f8f913c6111c5fa1981880f3438d02827f0f3a38232df`
- Rollback: `352bcb281990d59b7be747826b42b960215871b67a59c07d30f449490780565d`

## Validation results

| Check | Result |
|---|---|
| Final focused approval/queue/native/Create/plan suites | **257 passed, 0 failed, 0 skipped** |
| Final full branch suite | **2662 tests: 2587 passed, 70 failed, 5 skipped** |
| Untouched exact Production-source baseline | **2604 tests: 2528 passed, 71 failed, 5 skipped** |
| New failing test names versus baseline | **None** |
| TypeScript (`npm run typecheck`) | **Passed** |
| Lint (`npm run lint`) | **0 errors, 16 warnings** |
| Whitespace (`git diff --check`) | **Passed** |

One inherited failure is fixed: “the missed derivation reads the schedule, not the queue’s retry timestamp.” Remaining full-suite failures reproduce on the untouched baseline; they include environment restrictions (`listen EPERM 127.0.0.1`) and inherited source/expectation failures. They are not all environment failures, and the full suite is not green. No live UI test was performed.

New behavioral coverage includes campaign missing/stale versions and skipped state; real Post schedule/version saves; TikTok/YouTube route dates, owner isolation, editor/declaration versions and stale consent; Create sequencing and concurrent edits; exact lateness boundaries; retry clocks moved forward; stale claims; cancellation/withdrawal; explicit owner reschedule; late read-only reconciliation; rollback preservation and reapplication. Existing duplicate-confirmation coverage remains. Tests use real SQL in PGlite and route/data-layer/provider doubles where appropriate. Source guard assertions were updated to recognize versioned RPCs and distinguish queue expiry from actual publishing calls.

Focused command:

```sh
node --test tests/approval-safety-review.test.mjs tests/native-approval-review.test.mjs tests/approval-action-review.test.mjs tests/approval-safety.test.mjs tests/approval-integrity.test.mjs tests/mara-launch-post-api.test.mjs tests/marketing-plan-action-handoff.test.mjs tests/instagram-auto-publishing.test.mjs tests/instagram-publish-precision.test.mjs tests/production-readiness.test.mjs tests/campaign-social-queue-guard.test.mjs tests/redesign-batch-2.test.mjs tests/redesign-batch-3.test.mjs tests/plan-execution-ux.test.mjs
```

Full branch/baseline logs: `/tmp/voom-step1b-reviewed-full.log`, `/tmp/voom-step1b-baseline-full.log`. Focused log: `/tmp/voom-step1b-final-focused.log`. Type/lint logs: `/tmp/voom-step1b-final-typecheck.log`, `/tmp/voom-step1b-final-lint.log`. These are transient local verification logs.

## Remaining review gates

- Independent review of SQL locking/order, rollback and provider recovery semantics. Real simultaneous PostgreSQL sessions were not tested; deterministic interleaving/version checks do not prove contention behavior.
- Browser and authorized staging journeys for owner recovery, expired card handoff and all native consent platforms. The local socket restriction prevents the full browser/transport coverage here.
- Target hosted schema compatibility and deployment migration ordering need verification in a separately authorized release. No hosted catalog or customer records were inspected in this task.
- Existing full-suite failures and lint warnings remain; compare them to the baseline rather than treating this as a clean full-suite release gate.

**Ready for another independent review; stop locally. No release or Production change is authorized by this report.**

## Exact Step 1B file inventory

The following files changed in this follow-up, compared with the preserved Step 1 starting snapshot. Other Step 1 changes remain present and uncommitted; the historical Step 1 report records that earlier scope.

- `ARCHITECTURE.md`
- `DECISIONS.md`
- `app/api/mara/actions/[id]/route.ts`
- `app/api/social-drafts/[id]/route.ts`
- `components/voom/create/CreateSchedule.tsx`
- `components/voom/modals/SocialEditorModal.tsx`
- `components/voom/operating/ApprovalsBoard.tsx`
- `components/voom/operating/PlanItemCard.tsx`
- `docs/approval-safety-review-followup.md`
- `docs/approval-safety-review.md`
- `handover/next-session.md`
- `lib/instagram/publish-flow.ts`
- `lib/instagram/publish-queue.ts`
- `lib/instagram/publish-worker.ts`
- `lib/mara/approval-target.ts`
- `lib/mara/tools.ts`
- `lib/post/server-data.ts`
- `lib/social/server-drafts.ts`
- `lib/voom/approval-feed.ts`
- `lib/voom/create-draft.ts`
- `lib/voom/create-scheduling.ts`
- `lib/voom/schedule-guard.ts`
- `lib/voom/schedule-policy.ts`
- `lib/voom/workflow/actions-server.ts`
- `lib/voom/workflow/read.ts`
- `lib/voom/workflow/state.ts`
- `supabase/migrations/0080_approval_safety.sql`
- `supabase/rollbacks/0080_approval_safety.sql`
- `tests/approval-action-review.test.mjs`
- `tests/approval-integrity.test.mjs`
- `tests/approval-safety-review.test.mjs`
- `tests/helpers/native-video-db.mjs`
- `tests/instagram-publish-precision.test.mjs`
- `tests/marketing-plan-action-handoff.test.mjs`
- `tests/native-approval-review.test.mjs`
- `tests/plan-execution-ux.test.mjs`
- `tests/post-studio-production-0021.test.mjs`
- `tests/post-studio.test.mjs`
- `tests/redesign-batch-2.test.mjs`
- `tests/redesign-batch-3.test.mjs`
