# YouTube compliance integration — release checklist

Local integration branch: `codex/youtube-compliance-integration`, created with
`--no-track` from `origin/main` at `9043131a86cd285313a2a7bef6c64d4dde46b8e0`.
Prepared October 31, 2026. **Technical preparation is not operational/legal
compliance approval. Nothing here authorizes migration, deployment, publishing,
Google Console changes or a verification submission.**

## Implemented locally

- Integrated the existing owner-authenticated, same-origin YouTube erasure flow,
  durable database block, credential revocation outbox, authorization epochs,
  stale-response guards and 28-day maintenance with current main.
- Reconciliation still uses the same authenticated route and 300-second ceiling.
  Privacy maintenance runs first and shares the existing 240-second inner budget;
  PR #99's upload cleanup remains afterward. A cleanup failure defers cleanup,
  never deletes attached media or changes reconciliation success. A retention
  failure stops provider reconciliation. Overdue/expired privacy work produces
  a counts-only attention result/503; that is **not a delivered human alert**.
- Preserved current private-media bucket routing, strict range reads, resumable
  uploader, 50 MiB effective limit, 51-hour cleanup window and 0067 fairness.
  Existing approvals, per-item declarations and queue duplicate safeguards remain.
- Revocation credential expiry remains **six days**, as already implemented in
  unchanged 0065. The application now also checks expiry immediately before
  decrypting/using a claimed credential; expired, missing or malformed dates
  cannot reach Google. Expiry never counts as confirmed revocation or clears
  the pending-task reconnect barrier. Maintenance clears expired ciphertext.
- Corrected candidate policy wording to distinguish access blocking, incomplete
  erasure/recovery, six-day retry expiry, and seven-day deletion deadlines.
  These pages remain unpublished and require final eSmart review. No new legal
  entity, address, staffing, physical-backup purge or notification SLA is asserted.
- Original compliance worktree and its uncommitted contents are untouched.
  Instagram code, configuration and schedules are unchanged.

## Database boundary

The underlying already-reviewed migration remains unchanged:
`0065_youtube_data_retention.sql`, SHA-256
`2f612e4070dc2ed95d0fcbc463fe56dfe9d0618c806259f00a8002964de0a1f5`.
The operational-delivery follow-up adds local-only **0069_youtube_deletion_delivery.sql**
after 0065. It gates erasure on independent receipts and adds a private delivery
outbox; it is not applied to staging or Production. See
`docs/youtube-deletion-delivery.md` for the reviewed activation/receiver requirements.
No rewrite of the staging-installed SQL was made.
0066/0067/0068 files are unchanged.

The local upgrade regression installs 0066, 0067 and 0068 before 0065, checks
preservation of existing uploader/renewal definitions, Storage configuration,
original media and credit rows, and then exercises erasure and protected cleanup.
Fresh migration ordering is also covered by the focused suites.

0065 is one-time, transactional SQL; it is not an idempotent installer. Installation
does not invoke erasure/provider calls, but replaces existing disconnect/status
functions. Old application/UI behavior must not be left running indefinitely
against the new semantics. Coordinate a separately approved YouTube-only rollout.
Do not bulk-push missing migration numbers or restore erased API data as rollback.

## Independent register and alerts — adapter prepared, destinations NOT configured

The application database barrier/outbox protects normal operation, **not restoration
of an older database**. The disabled-by-default delivery adapter now prepares
independent intent/completion capture and failure alerts, but no real register or
alert service is provisioned, configured or tested. Local restore-replay tests simulate rolled-back database state
and an independent test journal; they do not certify actual backup restoration,
external journaling, alert delivery or infrastructure isolation.

Recommended architecture after owner approval:

1. Select an existing private support/ticket store independently recoverable from
   Supabase, with MFA, named access, auditable revisions and retention approved by
   the actual operator. An issue alone is not immutable or an independent backup.
2. Use a stable event/request UUID, original receipt and applicable deadline,
   verified VOOM owner UUID, scope, event type, actor, verification evidence and
   completion status. Do not export Google tokens, channel/video IDs, analytics,
   media or raw customer content. UUIDs are still protected personal data.
3. Require idempotent durable capture before erasure for email, disconnect,
   owner erasure, account deletion and automatic authorization-loss/retention
   events. The local server-only adapter requires authenticated durable receipts
   from the selected store. No destination/secret is configured. Missing capture
   leaves access blocked and deletion pending, not falsely complete. Do not send
   customer data to an invented URL.
4. Define outage handling: locally block unauthorized provider access immediately;
   escalate to the named on-call handler and use an approved independent receipt
   contingency. A journal outage must not silently extend deletion deadlines.
   A register populated only from occasional database exports has coverage gaps.
5. After selecting destinations, configure and prove notification delivery,
   acknowledgment and escalation using synthetic operational events under
   separate authorization. Proposed internal targets: acknowledgment within
   24 hours, completion within 48 hours, day-3 escalation, urgent day-5 and
   pre-day-6 revocation review. These are not currently adopted/public promises.
6. Keep restored data quarantined by controls outside the restored database;
   stop YouTube provider access/workers before use, replay every applicable
   deletion and no-repeat marker, verify originals/unrelated data, obtain
   independent review, then reopen selectively. Incomplete journal evidence
   means no reopening, or a separately approved sanitize-all-YouTube fallback.
   No automatic restore-release switch is implemented or claimed here.

## Technical release gates

- [x] Dedicated no-track branch on current main; narrowly scoped integration.
- [x] Migration 0065 byte-identical; no Production/staging SQL executed.
- [x] Combined reconciliation and uploader cleanup retained.
- [x] Six-day expiry checked again before credential use.
- [x] Focused local regression, upgrade and restore-replay coverage added.
- [x] Final focused test/typecheck/lint/build results recorded below.
- [ ] Approve final policy wording/effective date only after facts below settle.
- [ ] After external destinations are approved/configured, validate independent
      journal coverage/recovery and actual notification delivery.
- [ ] Before rollout, read-only Production preflight: identity, usable recovery,
      exact SQL/ACL prerequisites, partial-install absence, relevant locks and
      current-main review. Inspect legacy connection/evidence ages: first
      maintenance can erase records already past the retention limit.
- [ ] Separately approve the coordinated migration/application/policy rollout,
      keeping uploader limit, existing schedules and Instagram unchanged.

## Outstanding eSmart / owner sign-offs

- Actual legal operator/controller and appropriate business/privacy contact/address;
  confirm the published support email is staffed.
- Named primary deletion handler, deputy, authorized executor and escalation owner,
  including absence/weekend coverage.
- Actual independent register destination, access, capture coverage, alert
  recipients, recovery and minimal evidence-retention schedule.
- Confirmed backup/log/export inventory, managed-copy handling and expiry;
  seven accessible daily backups are not a physical-erasure guarantee.
- Adopt the restore-quarantine/replay procedure and applicable seven-calendar-day
  deadlines without restarting at ownership verification. External Google
  revocation has a separate 30-day maximum; the candidate uses conservative
  28-day maintenance, not proof that all managed copies are erased in 28 days.

## Local validation results — October 31

- **293 distinct focused tests passed, zero remaining failures or skips** across
  retention, OAuth, provider publishing, private/native/resumable uploads, cleanup
  fairness, migration histories, editor/TUS recovery, legal copy, native generation
  and credit reconciliation. Nine new integration cases were added.
- The first combined run passed 287; six existing uploader browser/transport tests
  could not bind localhost inside the sandbox. Those six passed on an authorized
  loopback-only rerun. New test-fixture assertion/setup errors found during test
  development were corrected; the final focused retention/legal/integration rerun
  passed all 49 cases. No real storage, Google, media-generation or publishing
  provider was called.
- The six browser/transport tests use the existing synthetic Chromium/loopback
  harness, not an authenticated user browser or hosted deployment. Browser plugin
  and its browser skill are not listed; the existing repository harness was reused.
  This is not an app-wide visual audit or a claim of live compliance acceptance.
- Final TypeScript, changed-file ESLint with zero warnings, and
  `git diff --check` passed. Final production build passed with the supported
  Webpack builder and synthetic-only environment values. The initial sandboxed
  build could not resolve Google Fonts; the authorized network-enabled local
  build fetched only the app's existing public fonts and passed.
- Upgrade coverage installs unchanged 0065 after 0066/0067/0068, preserves existing
  uploader/renewal functions and Storage configuration, and exercises original-media
  preservation and cleanup protection. This is embedded PostgreSQL validation,
  not a new hosted multi-session staging run. The earlier candidate's 21 hosted
  checks remain historical evidence; integrated hosted acceptance is a release gate.
- Restore coverage demonstrates a simulated database rollback can resurrect
  credentials and lose the local barrier, then verifies explicit journal replay,
  preserved originals and no-repeat controls. It does **not** prove a real
  infrastructure restore, external journal or human alert workflow is operational.
- Verified the new branch has no upstream. Original compliance tracked changes
  remain byte-for-byte unchanged; migration 0065's hash still matches staging.
  No push, commit, merge, deployment, remote SQL, configuration change or
  Production publishing occurred.

See `youtube-compliance-operations-pack.md` and `youtube-operational-signoff.md`
for the detailed worksheet. They retain historical candidate/staging evidence;
this checklist supersedes their old branch/base for the integrated release.

## Single next action

Return the named eSmart/owner decisions above, particularly the real register and
alert destinations, so the remaining external capture/notification work can be
explicitly authorized and validated before Production compliance is claimed.

## Operational-delivery follow-up — October 31

- Implemented disabled-by-default independent intent/completion capture, sanitized
  failure alerts, strict durable receipt checks, owner/lease validation, duplicate
  suppression and bounded recovery using the existing reconciliation cadence.
  No endpoint, credential or environment setting was configured.
- Added local-only transactional forward migration 0069. 0065 remains byte-identical
  with the hash above; 0066/0067/0068, uploader controls and schedules are unchanged.
  Installation creates no events or erasures. Coordinated staging validation of
  0065 + 0069 + application is still required before separately approved rollout.
- **311 distinct focused tests passed with zero remaining failures:** the initial
  regression run passed 308, three additional fault/cutoff/reporting cases passed,
  and the final delivery/retention/cron retest passed all 62. Final delivery coverage
  has 24 cases. TypeScript, zero-warning ESLint, diff checks and synthetic-environment
  production build passed. No real journal/alert/Google/storage service was called.
- Coverage includes absent/unsafe endpoints, delivery/acknowledgment loss, duplicate
  IDs and immutable deadlines, active-erasure completion failure, owner/lease/role
  isolation, account-delete bypass prevention, fixed retention cutoffs, restore
  replay simulation and in-place migration of prepared SQL calls. A newly discovered
  authorization-loss capture failure is reported in the same maintenance run.
- This is embedded/local validation, not independent-session hosted concurrency,
  an actual restore or external delivery proof. No external configuration, push,
  commit, merge, deployment, remote migration or Production operation occurred.
- **Release remains BLOCKED:** eSmart must approve the real operator/handlers,
  journal and alert destinations, credentials/access/recipients, evidence retention,
  backup/log/export handling and restore-quarantine operations. Independent capture,
  actual alerts/health monitoring and deadline handling must then be accepted with
  synthetic events under separate authorization. See `youtube-deletion-delivery.md`.
