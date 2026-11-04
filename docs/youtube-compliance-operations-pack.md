# YouTube compliance operations pack — owner sign-off draft

Prepared 30 October 2026 on `codex/youtube-data-retention`. Documentation only: no operational store, email automation, alert, access permission or Production setting was created/changed. No customer records or provider credentials were read/deleted. This file contains no real request data and must never become the customer request register.

Technical acceptance is recorded in `youtube-data-retention.md`. This pack turns the outstanding operations into a specific procedure and separates verified facts from proposed safeguards. It is not a legal certification.

## 1. Independent durable deletion register

### Recommended deployment choice — not yet provisioned

Reuse an owner-approved **private operations tracker outside Supabase and outside the application repository**, with MFA, named primary/deputy access, revision history and independent recovery. A dedicated private GitHub operations repository with one issue per request is a practical low-overhead option if the owner approves GitHub for this personal-data processing. An existing access-controlled support/ticket system with auditable revisions is an equally suitable alternative. Do not create either without owner approval. Do not use a local-only spreadsheet, public repository, application database table, or a store that is restored together with Production.

The selected store must preserve immutable event history or equivalent auditable revisions; corrections append a new event rather than overwrite receipt/deadline/evidence. Require a separately recoverable encrypted export or provider-verified independent history, and verify access/recovery before declaring the register operational. A private GitHub issue alone is not immutable or a second backup. An account-access failure or deleted issue must not silently erase the only erasure record.

Only authorized privacy staff may access it. Use a pseudonymous Voom owner UUID and a restricted pointer to the original support thread; do not copy email bodies, passwords, tokens, Google channel/video IDs, analytics or customer media into the register. Pseudonymous identifiers are still protected personal data. Access rights and any data-residency/processor acceptance require the operator's confirmation.

### Required request fields

| Field | Rule |
| --- | --- |
| `request_id` | Random stable UUID; unique per received request, not per retry. |
| `received_at_utc`, `source`, `source_reference` | Original email receipt or owner action time and restricted event/thread reference. Never reset after verification, handoff or retry. |
| `scope` | `youtube_only` or `full_account`; do not infer full-account consent from disconnect. |
| `owner_user_id` | Populate only after a reliable owner mapping; never guess from display name. |
| `ack_due_at_utc`, `target_due_at_utc`, `hard_due_at_utc` | Receipt +24 hours, +48 hours, +7 calendar days respectively. Use UTC timestamps and display Dubai time for staff. Choose the conservative earlier deadline if calendar interpretation differs. |
| `verification_status`, `verified_at_utc`, `verification_method`, `verified_by` | `pending`, `verified`, `needs_user_action` or `rejected`; describe the method, not passwords or documents. |
| `assigned_primary`, `assigned_deputy`, `technical_executor` | Real authorized identities supplied by owner; never placeholders in a live register. |
| `erasure_status` | `received`, `verification_pending`, `verified`, `blocked`, `erasing`, `live_data_erased`, `exception` or `closed`. Record each transition and actor separately. |
| `access_blocked_at_utc`, `erasure_started_at_utc`, `live_erasure_verified_at_utc` | Distinguish a requested block, committed block, attempted purge and independently verified completion. A timeout is not proof of success. |
| `revocation_status`, `revocation_verified_at_utc` | `not_attempted`, `pending`, `confirmed`, `already_invalid` or `operator_followup`; no Google response bodies/tokens. |
| `evidence` | Code/migration revision, checked owner UUID, zero-count results for relevant live API-data tables, preserved-originals check, receipt time and verifier identity; never provider identifiers or raw row dumps. |
| `backups_status`, `restore_replay_required`, `backup_expiry_evidence` | Track unresolved managed-copy/export/log handling independently of live deletion. No invented expiry date. |
| `customer_notified_at_utc`, `completion_reference`, `closed_at_utc` | Restricted pointer to the truthful completion notice. Close only after required scope/evidence is reconciled; unresolved provider/backup tasks remain explicit. |
| `event_id`, `event_at_utc`, `actor`, `event_type`, `previous_event_reference` | Append-only audit events; retry/duplicate input references the same request rather than creating conflicting deadlines. |

### Capture rules and restore coverage

1. Email intake: create the external record as soon as received, before destructive work. The external receipt timestamp remains the deadline source even though the application's SQL request timestamp may be later.
2. In-app disconnect/erasure and full-account deletion: record an independently durable event **before** erasure; keep the request even if execution subsequently fails. This also applies to authorization-loss/retention erasures when a restore must not resurrect them.
3. The local candidate now includes the disabled-by-default adapter and forward migration 0069 described in `youtube-deletion-delivery.md`. It requires independent intent and active-erasure completion receipts, retries failures and stages alerts. **No destination, credential or independent receiver is configured or verified.** Local outbox state does not survive an older database restore. Do not certify complete restore replay from a manually copied subset of events or from unit tests.
4. Until capture coverage is proven, any restore must remain quarantined. A missing/unavailable journal or a gap in automatic events means **no resumption**. A separately approved fallback is to sanitize all restored YouTube API-derived data, retain legitimate original content, reconcile duplicate-prevention controls and require fresh owner authorization—not guess which accounts were erased. This pack does not authorize that bulk action.
5. Retain minimal replay evidence through the longest actual restore/export horizon plus the documented reconciliation margin, then apply an approved privacy/legal schedule. Indefinite retention is not a default. No numeric final journal-retention promise is made before the operator confirms requirements.

## 2. Intake, notification and escalation procedure

Published intake remains `pavjassehgal@gmail.com`. Its presence in code is confirmed; staffing, absence cover and alert delivery are not. No email is sent by preparing this procedure.

| Time from original receipt | Required action | Responsible role |
| --- | --- | --- |
| Immediately at intake | Register original receipt/scope/deadline, assign real primary/deputy, check for duplicate request. | Intake handler |
| Before 24 hours | Send acknowledgement; start ownership verification through the existing authenticated account/sign-in channel. Escalate internally at 20 hours if unacknowledged. | Primary; deputy if primary unavailable |
| Before 48 hours | Internal completion target: execute authorized owner-scoped erasure, verify active-system removal and revocation outcome, record evidence, notify customer truthfully. | Authorized executor + primary |
| At 48 hours if incomplete | Notify primary, deputy and accountable operator; record obstacle, next action and next review time. Do not close the request. | Primary/deputy |
| Day 3 | Operator escalation; review at least daily, including weekends, until resolved. | Accountable operator |
| Day 5 | Urgent review of outstanding data, provider revocation, journal/restore obligations and infrastructure failures. | Operator + executor |
| Before day 6 | Resolve/escalate unconfirmed revocation before the candidate's six-day encrypted-task expiry. Destroyed ciphertext cannot be retried; do not blindly clear an expired task or unblock reconnect. Ask the actual owner to revoke in Google settings if needed; never impersonate them. | Executor + operator |
| By seven calendar days | Applicable YouTube deletion limit; outages or delayed verification do not silently restart/extend it. If a breach is imminent/occurred, notify the operator immediately, preserve evidence and obtain compliance advice. | Accountable operator |

Owner verification: prefer the existing authenticated owner-only Voom flow. For email, validate access through the established account's sign-in/contact channel and map the correct UUID. A sender header or knowledge of a business name alone is insufficient. Never request passwords, OAuth tokens or sign in as the customer. Do not disclose account existence/content to an unverified requester. If verification stalls, keep the original deadline and escalate safely rather than deleting an unrelated person's data.

After release, the executor uses the approved owner-scoped route or server routine only, checks the durable access block and completion evidence, and preserves original drafts/media and unrelated providers for a YouTube-only request. Full-account deletion still requires the broader account/media procedure, not merely the YouTube API. Do not turn a timeout into a success receipt or retry any uncertain publication.

Monitoring: a named person must review the independent register at least twice daily, including weekends; verify acknowledgement/completion alarms at setup. Monitor the existing authenticated YouTube reconciliation cron and private backlog for failed requests, overdue work and expired revocations. A 503 response is not an alert unless an approved monitor delivers it. No cron endpoint is to be manually invoked to test an alert. Validate delivery with a synthetic operations-only notification after separate authorization.

### Prepared email text — unsent, replace only verified fields

**Acknowledgement subject:** Voom deletion request received — {{request_id}}

We received your request on {{received_at}} to delete {{confirmed_requested_scope}}. Your reference is {{request_id}}. We will verify account ownership through your existing account sign-in/contact channel; please do not send passwords or Google tokens. Our internal completion target is {{target_due_at}}, with the applicable YouTube-data deadline recorded as {{hard_due_at}}. We will contact you promptly if we need clarification. Deleting data from Voom does not delete your video from YouTube itself.

**Internal escalation subject:** ACTION REQUIRED — deletion request {{request_id}} — due {{hard_due_at}}

To: the real assigned primary, deputy and accountable operator (resolve from the restricted register; never send to a placeholder). Request {{request_id}} is {{status}}. Verification: {{status_only}}. Obstacle: {{non_sensitive_summary}}. Next action: {{action}}. Assigned executor: {{real_identity}}. Next review: {{review_time}}. Open the restricted register for details. Do not include tokens, channel/video IDs, raw request content or media in email. Original receipt/deadline must remain unchanged.

**Completion subject:** Voom deletion request update — {{request_id}}

We verified removal of {{actually_removed_scope}} from Voom's active systems on {{verified_completion_time}}. {{State whether Google authorization revocation is confirmed, already invalid, or still pending; do not select a success statement without evidence.}} {{State the actual confirmed backup/export handling, or explicitly identify unresolved handling and the next update time.}} {{For a YouTube-only request, state that original Voom drafts/media were preserved only if verified.}} Your content on YouTube itself was not deleted. Contact us quoting {{request_id}} if you have questions.

An update confirming active-system removal while provider/backup handling remains unresolved is **not** a claim that every copy was deleted or that the entire request is closed.

## 3. Safe restore runbook — planning only, not execution approval

1. Open an incident/change record outside Production. Identify the exact target/backup, accountable operator, executor and independent reviewer. Record backup timestamp/schema version and obtain separate restore approval. Prefer an isolated replacement project over restoring in place.
2. Before restoration, positively prove a **restore-independent block** on application access and all YouTube provider calls/workers, including Supabase/Vercel schedules, manual worker routes, old deployments and cached clients. Database barriers alone are insufficient: the backup can roll them back. Endpoint authentication or deployment protection alone does not stop an already authorized cron. A stop switch must be effective outside the restored database. Its exact controls require a reviewed restoration change; none are changed here.
3. If the block cannot be proved, stop. If restoring in place is unavoidable, isolate application traffic and all applicable workers before the database goes back online. Do not disturb unrelated integrations as an ad hoc shortcut; scope and approve the maintenance effects first.
4. Restore into quarantine with no provider egress and no live cron execution. Do not attach Production app credentials, public routing or restored cron schedules until reviewed. Database backups do not restore deleted Storage bytes, so media-metadata pointers may also require verification.
5. Validate schema/function versions. Never blindly reapply 0065: it is a one-time migration. Inspect whether it exists, and use the reviewed targeted installation/version-appropriate forward procedure only with approval.
6. Load the independent journal, verify completeness through the restore point and all later erasures, including automatic invalid-authorization/retention events. Replay verified erasures by Voom owner UUID; if the owner is absent, verify absence instead of creating an account. Apply the minimal no-repeat publication markers for erased/uncertain submissions. Do not automatically replay a Google revocation using a stale restored credential, potentially affecting a later grant; reconcile authorization epochs and revocation evidence first.
7. Do not restore deleted connection history as a remedy for a missing marker. Missing journal coverage or unavailable evidence means keep quarantine, or obtain separate approval for the sanitize-all-YouTube fallback in section 1. Do not guess which restored jobs are safe.
8. Read-only verification must show erased API data/credentials absent, required duplicate-prevention markers present, legitimate original drafts/media preserved and all remaining jobs individually reconciled. Restore is not permission to publish or resume an uncertain upload. Mark stale queued work for owner review under the approved procedure.
9. The independent reviewer records the checks and signs the external register/change record. The operator authorizes selective reopening and monitors the existing reconciliation health before any publishing schedule is re-enabled. Never run an upload as a restore test.

## 4. Backup facts and unresolved copy inventory

Read-only recheck on 30 October 2026 positively identified Production `spqkkbznzxxkdtexyqzh` / `Voom-real2` as healthy. Physical backups are enabled, PITR disabled, and seven completed physical backups dated 23–29 October are listed; latest is `2026-10-29T23:48:45.274Z`. The previously inspected dashboard identifies the organization as Pro. Supabase documents **seven days of accessible daily backups for Pro**, not a customer-selectable guarantee of immediate physical erasure of every copy. No restore, backup download or settings change was performed.

| Copy category | Known | Required remaining confirmation |
| --- | --- | --- |
| Managed database backups | Daily physical backups; seven available daily recovery points; PITR off. | Provider-confirmed physical expiry, other managed/WAL/disaster-recovery copies and handling of deletion requests in those copies. Do not infer exemption or guaranteed purge from the visible recovery window. |
| Manual exports/downloads | No complete inventory established by repository documentation. | Owner must identify destinations, access, creation/retention schedules and whether any contain YouTube API data. Do not assume none exist. |
| Application/database logs and log drains | End-to-end retention/destinations unverified. | Confirm actual destinations/periods and whether historical provider payloads/identifiers occur; minimize/sanitize under an approved change. Never copy real logs into this public-facing documentation. |
| Storage/CDN | Supabase database backups contain Storage metadata, not object bytes. Original user media is not automatically YouTube API-derived data. | Confirm any actual exported/cached API responses and separately applicable customer-media deletion instructions. Do not promise all storage is erased by disconnect. |
| Email/ticket/register copies | Published intake address is known; external register not yet provisioned. | Choose minimal retention and access for identity-verification correspondence, evidence and restore markers. Keep request replay evidence independent of database restore. |

**Recommended defaults:** do not extend backup retention or create new API-data exports for this release; minimize API identifiers in logs; remove unnecessary copies through a separately authorized process; retain restricted replay evidence only for the longest verified recovery horizon plus an approved reconciliation margin. Provider/counsel confirmation is needed for residual managed copies. No universal numeric retention period or backup exception is asserted.

## 5. Exact Privacy Policy/deletion wording — approval-gated

These are prepared replacement paragraphs, not deployed claims. Preserve existing Google policy/security links. The existing support address is factual; legal identity is intentionally omitted pending section 6. Do not publish an incomplete operator section.

### Confirmed-facts wording, suitable for owner review now

> You can request deletion of your Voom account data or stored YouTube data by emailing pavjassehgal@gmail.com and specifying the scope of your request. We verify account ownership before acting and do not ask for your password or Google OAuth tokens. Deleting data held by Voom does not delete videos held by YouTube; manage those videos directly through YouTube.

> Voom uses Supabase for its application database. The current Production project has daily physical database backups and a seven-day accessible daily-backup recovery window; point-in-time recovery is not enabled. Database backups do not include the media files stored through Supabase Storage, although they include storage metadata. The accessible recovery window does not establish when every residual managed copy is physically destroyed.

The second paragraph is a factual infrastructure disclosure, **not a complete retention policy**. It must be supplemented by confirmed copy expiry/restore handling before final compliance sign-off. Do not simply delete uncertainty from the wording to make the application look compliant.

### Publish only after the tested release AND operations adoption are verified

> When you disconnect YouTube in Voom or request deletion of its stored API data, Voom blocks further access and removes the related channel details, publishing credentials, OAuth state, upload-session information, YouTube publishing history, returned video references and performance snapshots from active systems. For a YouTube-only request, your original Voom drafts, captions, proposed posting times and uploaded or generated media are preserved. Previous YouTube approvals are withdrawn. Minimal Voom-only draft/action identifiers may remain to prevent a previous or uncertain upload from being repeated; these contain no Google channel ID, video ID or analytics. A video already sent to YouTube may finish processing there.

> We attempt to revoke Google authorization immediately when you disconnect. If that request fails, encrypted revocation material is isolated from publishing and retried; its active retry credential expires after six days and unresolved revocation is escalated. Confirmed invalid authorization also stops access and triggers removal of related stored API data. Routine checks verify continued authorization, and API-data snapshots or unchecked provider evidence are refreshed or removed within the implementation's 28-day limits. A temporary network failure alone is not treated as proof that you revoked consent.

> We acknowledge deletion requests within 24 hours and aim to complete them within 48 hours. Applicable YouTube-data deletion is completed as soon as possible and within seven calendar days of the request, including a request to delete your Voom account; ownership verification does not restart that deadline. Other account-data handling is explained separately. We distinguish verified active-system deletion, Google authorization revocation and any remaining backup handling in our response.

> We keep a restricted deletion-request register outside the application database's restore scope, recording receipt, ownership verification, deadlines and completion evidence. We do not put Google tokens or YouTube channel/video identifiers in that register. Restored data remains isolated from the application and YouTube workers until relevant deletions and duplicate-prevention safeguards have been reconciled and independently checked.

The last two paragraphs are commitments to **adopted operations**, not facts proven by code tests. Do not publish them merely because this pack exists. External capture coverage, alert delivery, actual backup/export/log periods and the register's approved retention must be verified before signing the final policy. Add the confirmed operator identity/contact only after the owner supplies them; no fictitious legal text is provided.

## 6. Only owner decisions still required

1. **Legal identity/contact:** individual legal operator or registered company, and appropriate business/privacy address/contact. Recommend the actual existing operator; do not create a paper company or use an invented address to pass review. Obtain jurisdiction-appropriate advice if unsure.
2. **People and coverage:** real primary, deputy and authorized technical executor, with daily/weekend availability and alert recipients. Recommend distinct primary and deputy; retain the existing published email unless the owner selects an established monitored alternative. The requested 24-hour acknowledgement/48-hour target are already included, not another decision to defer.
3. **External register and access:** approve a named existing private support tracker or dedicated private operations repository and its authorized users. Recommend reuse over a new feature; require independent recovery, restricted audit history and proven capture of all erasure sources. Actual setup/integration needs separate authorization once the destination is selected.
4. **Retention and recovery approval:** disclose any existing exports/log archives; approve a minimal legal evidence-retention schedule based on the longest actual restore horizon and authorize obtaining provider/counsel confirmation of residual copies. Recommend no new API-data exports or longer backup window, and fail-closed restore reconciliation. Do not choose an unsupported physical-purge promise.

Once these choices are supplied, record the actual names, destinations and verified retention facts, finish any required capture/alert integration under separate authorization, and approve the coordinated application/migration/policy rollout. No additional technical staging acceptance run is requested here.

## Sources

- [Supabase database backups](https://supabase.com/docs/guides/platform/backups): plan-based recovery windows, restore behavior, Storage-object limitation.
- [YouTube API Services Developer Policies](https://developers.google.com/youtube/terms/developer-policies), III.D.2 / III.E.4: revocation, user-request deletion deadlines and stored-data rules.
- Repository evidence: `lib/legal/contact.ts`, `lib/youtube/privacy.ts`, `app/api/integrations/youtube/data/route.ts`, `supabase/migrations/0065_youtube_data_retention.sql`, `docs/youtube-data-retention.md`, `docs/youtube-operational-signoff.md`.
