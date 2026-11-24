> Step 1B follow-up supersedes this historical Step 1 report: see
> [approval-safety-review-followup.md](approval-safety-review-followup.md).

# VOOM Step 1 — Approval safety review

24 November 2026, Dubai. **Implemented locally; not deployed. Ready for independent code and migration review, not production release.**

## Checkout and restrictions

- Base and current HEAD: `569f27c74e247a3568fdbb089cf39c0ed71fdb0a` — the established production source baseline.
- Branch: `codex/approval-safety-569f27c`.
- Location: `/Users/pavjassingh/Documents/GitHub/voom-real/.worktrees/approval-safety-569f27c`.
- Changes are **uncommitted**. No new commit SHA exists.
- This is an independent local Git checkout: linked-worktree creation was blocked by the original repository's read-only Git metadata, and the managed-worktree tool was unavailable. A local clone provided the requested branch isolation without altering the original repository's refs.
- No push, merge, deployment, hosted database write/migration, paid generation, customer-content mutation, billing/credential/account change or Meta App Review change occurred. Existing Memory and Gurnoor checkouts were not edited. One new SQL file was initially written in the original checkout, then moved into this checkout; no existing original-checkout file was edited.

## Confirmed causes and fixes

| Problem | Confirmed cause | Local fix |
|---|---|---|
| N05: reviewed version omitted | `approvePostDraft` accepted an optional version; Plan and Post Editor omitted it. Create could approve a version obtained after an unguarded save. Campaign decisions had another shortcut. | Shared post approval requires a reviewed version at runtime and in its TypeScript signature. Plan, Post Editor, Create and Instagram campaign decisions carry the displayed version. Create schedule-save compares the original version and verifies the resulting schedule revision before approval. Missing or stale review versions fail closed. |
| Approval card can change while open | Confirmation claimed the current server proposal, without binding it to the browser's displayed card revision. | Browser sends `reviewedAt` and, for linked drafts, `contentVersion`. Claim compares `updated_at`; the exact displayed draft version must also match. Legacy cards without review context cannot be silently confirmed. Stale linked calendar cards refresh for another explicit review. |
| V8: September approval still executable | The proposal could remain pending indefinitely; confirmation did not revalidate its schedule against current time. Edit validation also tolerated past times. | Approval transactions use database current time and the stored absolute schedule, with a one-minute minimum lead. Business timezone is read/validated; new choices in Plan/Post Editor/Create/approval edits use business-local conversion. Expired items return a conflict with explicit Change time/Edit instructions. No replacement time is selected automatically. |
| Cancellation/confirmation and duplicate outcomes | Draft approval, action completion and subsequent mirroring occurred as separate unchecked operations; status checks differed by caller. | New transactions lock owner-scoped actions/drafts and reject rejected, cancelled, superseded, mismatched and provider-owned states. A linked action's confirmation and draft approval commit together; campaign action confirmation is also bound into that transaction. Duplicate card confirmation cannot execute again. Same-version direct retry is idempotent and does not create another queue identity. |
| Late sync recreates withdrawn state | A stale application read could be used after an edit/cancellation when writing calendar/queue state. | Calendar and Instagram enqueue wrappers recheck the still-approved content version under the draft lock, reusing existing mirrors and queue functions. Existing integrity triggers withdraw unclaimed work after edits. Create only shows Scheduled when the API verifies a scheduled queue row. |
| Native approval can race a changed video | Native explicit approval did not consistently compare the browser-reviewed base version during its draft write. | Social editor and TikTok post sheet send the reviewed version; explicit authorization uses an owner/version/status conditional write. TikTok keeps its full consent/fingerprint/declaration flow. Only its trusted consent endpoint may authorize the existing explicit Post now behavior; a future schedule must still be future at final validation. Campaign TikTok/YouTube approvals hand off to the platform editor. |

Post Editor also refuses to approve persisted content while different unsaved edits are visible. Unsupported legacy draft kinds fail before approval state is changed. Standalone calendar creation and scheduling updates finalize atomically; scheduling updates compare the target's stored revision, and draft-backed entries must be changed through their source editor.

The existing Instagram/TikTok/YouTube/LinkedIn provider workers, provider-success criteria, publishing consent and LinkedIn approval mechanism were preserved. No new automatic publishing, paid-media generation or automatic retry behavior was introduced. Scheduled publication still uses the existing explicit approval/consent and provider workers.

## Database migration — not applied remotely

Proposed `supabase/migrations/0080_approval_safety.sql` adds service-role-only functions:

- `approve_reviewed_post`: exact version/state/media/future-time checks and atomic action/campaign decision.
- `reject_reviewed_post`: guarded rejection and resolution of pending decisions, reusing existing withdrawal triggers.
- `confirm_calendar_proposal` and `confirm_calendar_update`: atomic standalone scheduling decisions.
- `sync_reviewed_post_calendar` and `enqueue_reviewed_instagram_post`: approved-version checks at synchronization boundaries.

Functions use explicit owner predicates, an empty search path and revoked browser/public execution rights. Existing content-version and withdrawal triggers from 0059 remain authoritative. Stable sibling-action lock order avoids competing card decisions taking opposite action locks.

The file has run only in the embedded local PostgreSQL test harness. It creates helper functions; it does not migrate customer rows, schedule jobs or change provider accounts. Production 0078 Instagram receipts is preserved; 0079 is left for the separate Memory candidate. The final combined migration numbering still needs integration review.

**Release dependency:** application changes require this reviewed migration. Missing RPCs fail closed. A future release must coordinate migration and app rollout under separate authorization. Do not deploy this branch as-is without that review.

## Verification

| Check | Result |
|---|---|
| Untouched production baseline, `npm test` | 2,604 tests: **2,528 passed, 71 failed, five skipped** |
| Full changed suite, `npm test` | 2,636 tests: **2,560 passed, 71 failed, five skipped**; **no new failing test names** compared with baseline |
| Final focused run after final safety adjustments | 248 checks: **247 passed, zero failed, one skipped** |
| `npm run typecheck` | Passed: Next route type generation and TypeScript |
| `npm run lint` | **Zero errors, 16 warnings** |
| `git diff --check` | Passed |
| Live UI / hosted services | Not tested or changed |

New regression coverage consists of `tests/approval-safety.test.mjs` (22 behavioral database/boundary checks), `tests/approval-action-review.test.mjs` (eight real-handler tests with synthetic dependencies), and three additional post-API approval tests. Existing affected approval/native tests and migration-order inventories were updated.

Coverage includes: missing/stale review versions; edits and media replacements before approval; withdrawal after an edit; September and near-expired schedules; explicit future rescheduling with a new review; owner isolation; rejected/cancelled/failed/unclaimed/superseded/confirmed cards; repeated and overlapping confirmations; provider-owned/published locks; standalone insertion/update atomicity; business-zone date boundaries; and RPC execution privileges. Existing native publishing tests continue to verify consent, durable queues and provider truth.

The final focused command was:

```sh
node --test tests/approval-safety.test.mjs tests/approval-action-review.test.mjs tests/mara-launch-post-api.test.mjs tests/marketing-plan-action-handoff.test.mjs tests/production-readiness.test.mjs tests/campaign-social-queue-guard.test.mjs tests/marketing-plan-channel-assignment.test.mjs tests/tiktok-provider.test.mjs
```

The focused skip checks Git history against a `main` branch absent from this isolated clone. The full-suite failures also occur on the untouched baseline: they include browser/network/transport checks blocked by `listen EPERM 127.0.0.1`, plus existing source/expectation failures. They are not all environment failures. No unrelated production behavior was changed to make those tests green. The last narrow adjustment (blocking unsupported legacy caption kinds before approval) is covered by the final focused run.

## Remaining review and release gates

1. Independently review the app diff and 0080 SQL, including lock ordering, privileges and rollout/rollback coordination.
2. Run true multi-session PostgreSQL contention tests. Embedded PostgreSQL tests cover SQL state transitions, interleaved edits and overlapping calls, but do not establish multi-session lock behavior or absence of every production deadlock.
3. Run local/staging browser journeys for Plan, Post Editor, Create, Approvals and native consent sheets. This environment prevents local HTTP listeners, so the browser-based suite could not complete. No live UI claim is made.
4. Review recovery after an approval commits but calendar/queue synchronization fails. Version-checked synchronization is safe to retry through the source editor/Plan; it must not be mistaken for verified scheduling. Existing in-flight/provider-owned work remains outside cancellable local state.
5. Previously scheduled or already-submitted production records were not inspected or repaired. These fixes govern new confirmation attempts; historical publishing decisions are not retroactively changed.
6. Email campaign approval/send workflows are separate and unchanged. Unsupported historical MARA draft kinds require the appropriate current editor rather than implicit approval through the Instagram boundary.

**Status:** local implementation and focused regression checks are complete. Ready for independent review. Not approved for push, merge, migration application or deployment.

## Exact file inventory

All paths below are relative to the isolated checkout. No dependency or Vercel configuration file changed.

### Application source

- `app/api/mara/actions/[id]/route.ts`
- `app/api/posts/[id]/route.ts`
- `app/api/social-drafts/[id]/route.ts`
- `app/api/social-drafts/[id]/tiktok-post/route.ts`
- `app/api/voom/campaigns/[id]/actions/[actionId]/route.ts`
- `app/app/(shell)/approvals/page.tsx`
- `components/voom/create/CreateSchedule.tsx`
- `components/voom/modals/AutomatedCampaignModal.tsx`
- `components/voom/modals/PostEditorModal.tsx`
- `components/voom/modals/SocialEditorModal.tsx`
- `components/voom/modals/TikTokPostSheet.tsx`
- `components/voom/operating/ApprovalsBoard.tsx`
- `components/voom/operating/ApprovalsWorkspace.tsx`
- `components/voom/operating/PlanItemCard.tsx`
- `lib/campaign/server.ts`
- `lib/campaign/types.ts`
- `lib/instagram/publish-queue.ts`
- `lib/mara/tools.ts`
- `lib/post/approval-safety.ts`
- `lib/post/server-data.ts`
- `lib/social/server-drafts.ts`
- `lib/voom/create-draft.ts`
- `lib/voom/create-readiness.ts`
- `lib/voom/workflow/actions-server.ts`
- `lib/voom/workflow/read.ts`
- `lib/voom/workflow/service.ts`

### Tests and migration inventories

- `tests/ai-usage-cost-tracking.test.mjs`
- `tests/approval-action-review.test.mjs`
- `tests/approval-safety.test.mjs`
- `tests/assisted-approval-reliability.test.mjs`
- `tests/automation-resume-reliability.test.mjs`
- `tests/brand-kit-context.test.mjs`
- `tests/campaign-social-queue-guard.test.mjs`
- `tests/campaigns-v3-pglite.test.mjs`
- `tests/campaigns-v3-unified-channels.test.mjs`
- `tests/complete-content-approval.test.mjs`
- `tests/email-automation-flows-pglite.test.mjs`
- `tests/instagram-auto-publishing.test.mjs`
- `tests/mara-launch-post-api.test.mjs`
- `tests/mara-media-brief.test.mjs`
- `tests/marketing-plan-action-handoff.test.mjs`
- `tests/marketing-plan-channel-assignment.test.mjs`
- `tests/multi-social-core.test.mjs`
- `tests/post-format-persistence.test.mjs`
- `tests/post-studio-production-0021.test.mjs`
- `tests/post-studio.test.mjs`
- `tests/production-readiness.test.mjs`
- `tests/tiktok-provider.test.mjs`
- `tests/voom-operating-system.test.mjs`
- `tests/youtube-provider.test.mjs`

### Migration and documentation

- `ARCHITECTURE.md`
- `DECISIONS.md`
- `docs/approval-safety-review.md`
- `handover/next-session.md`
- `supabase/migrations/0080_approval_safety.sql`
