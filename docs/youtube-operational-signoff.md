# YouTube operational sign-off — awaiting owner decisions

October 31 addendum: the integrated local candidate now has a disabled-by-default
independent delivery adapter and unapplied forward migration 0069. See
`youtube-deletion-delivery.md` for receipt gating, retry/alert behavior and receiver
requirements. No actual destination, credentials, alert recipient or external
durability was configured/verified. The owner decisions and release block below
remain in force; historical technical counts below are not a new certification.

Reviewed 30 October 2026. **BLOCKED for final operational sign-off**, not a new technical staging failure. No tests repeated, customer data accessed/deleted, settings changed, or release performed.

The detailed register fields, acknowledgement/escalation templates, fail-closed restore procedure and approval-gated policy wording are prepared in [the operations pack](youtube-compliance-operations-pack.md). It documents safeguards; it does not claim an external register, email automation or alert integration is already operational.

## Confirmed evidence

| Area | Confirmed | Not established |
| --- | --- | --- |
| Legal operator | The repository and live legal pages use the brand **Voom** and contact `pavjassehgal@gmail.com`. Supabase organization is displayed as **Voom / PRO**. | A brand, account handle or support email does not establish the legal controller. No legal person/entity, address or named accountable privacy operator was identified in the inspected documents. |
| Production recovery | Management API positively identified `spqkkbznzxxkdtexyqzh` / `Voom-real2`, healthy. Dashboard shows Pro and seven daily physical backups, 23–29 October. Latest completed backup: `2026-10-29T23:48:45.274Z`. PITR is disabled. Supabase documents a seven-day accessible daily-backup window for Pro. | This is not proof of the physical destruction time of every provider-managed copy. Off-site exports, logs, downloads, support emails and other archives have no verified end-to-end retention schedule in the inspected evidence. No restore was attempted. |
| Requests today | Public instructions accept email at `pavjassehgal@gmail.com`, preferably from the account address, with business and deletion scope. Staff may request ownership confirmation. | No named primary/deputy, rota, inbox-review evidence, ticket register or independently retained deletion journal is documented. Sending email alone does not prove ownership. |
| Candidate implementation | Owner-session and same-origin checks protect the YouTube erasure route. Database controls record request/completion times; the existing authenticated reconciliation worker performs bounded recovery/retention and reports overdue/expired tasks. | Email receipt does not automatically create a database request. Database controls are not an email ticket system or an independent append-only restore journal; account deletion can cascade them and restoring a backup can roll them back. Returning HTTP 503 is not evidence of a configured human alert. |
| Public wording | Anonymous HTTP 200 on `/privacy`, `/terms`, `/data-deletion`. All display **September 21, 2026**. Live deletion instructions currently use **30 days after verification** and state no automated deletion endpoint. | The local October 30 candidate's YouTube seven-calendar-day rule, automatic disconnect erasure and retry disclosures are not live. Do not describe them as existing Production behavior. |

Sources: [Production backups](https://supabase.com/dashboard/project/spqkkbznzxxkdtexyqzh/database/backups/scheduled), [Supabase backup documentation](https://supabase.com/docs/guides/platform/backups), [live Privacy](https://voom.today/privacy), [live Terms](https://voom.today/terms), [live deletion instructions](https://voom.today/data-deletion), `lib/legal/contact.ts`, `lib/youtube/privacy.ts`, migration 0065 and the staging acceptance report.

## Restore risk and mandatory procedure

Daily backup restoration can restore channel identity, encrypted credentials, queue history and analytics that were deleted afterward. It can also remove newer erasure barriers/tombstones, potentially making previously submitted jobs look eligible again. The migration does not prevent an operator from restoring an older database.

**Proposed safe default, not an existing verified operational practice:** keep a minimal restricted deletion register outside the database's restore scope. Record Voom owner UUID, request scope, original receipt/deadline, verification method, action/completion times and minimal evidence; never copy Google tokens, video IDs or analytics into it. Keep it at least through every applicable restore horizon plus the time needed to reconcile a restore, then apply an approved minimal retention schedule.

On any restore: block application/provider access and workers first; keep the restored environment isolated; ensure the approved privacy schema exists; replay applicable erasures against restored owners and reconcile minimal duplicate-prevention markers; verify no erased credentials/history/jobs remain; obtain a second check before reopening access or workers. If an owner is absent, verify absence rather than creating an account. Never restore erased API data as the way to recover a deletion failure.

Supabase database backups do not include Storage objects themselves, only their metadata. Original customer media is separate from YouTube API-derived data. Seven available daily backups are **not**, by themselves, proof of compliance or a blanket exemption for backups. Confirm managed-copy expiry and any delayed-erasure treatment with the provider and qualified counsel; do not promise an unverified purge period.

## Proposed request-handling procedure — requires named owners and adoption

1. **Intake handler:** review the published inbox daily, including weekends; record the original request receipt, scope and a seven-calendar-day YouTube deadline immediately. Recommended internal targets: acknowledge within 24 hours and complete within 48 hours; escalate unresolved work by day 3, with a deputy covering absence. These are proposed targets, not existing facts.
2. **Identity verification:** prefer the customer's existing authenticated Voom session/owner-only action. For email requests, verify control through the established account sign-in/contact channel and check the correct owner UUID. Do not rely solely on a sender header, reveal account details to an unverified sender, impersonate the user or request passwords/tokens. Do not restart the YouTube deadline after verification.
3. **Authorized technical handler, after the approved release:** run only the owner-scoped YouTube erasure flow, preserving original drafts/media and unrelated platforms for a YouTube-only request. Do not directly delete arbitrary rows, reactivate jobs, or blindly repeat an uncertain provider publication. A full-account request still needs the existing broader account/media deletion process; the YouTube-only route is not a full-account deletion facility.
4. **Verification and recovery:** confirm the durable access block, removal of YouTube credentials/identity/history/snapshots/provider references, and preservation of unrelated data. Check revocation completion or durable pending state. Monitor cron failures, overdue requests and expiring revocation work; assign an alert recipient. Expired ciphertext is deliberately destroyed after six days: an unresolved Google revocation requires operator follow-up, not clearing a warning or unblocking reconnect blindly.
5. **Completion:** update the independent register and email the verified customer a truthful completion receipt, distinguishing Voom-side deletion, Google-side revocation and any unresolved backup handling. Voom does not delete the customer's video from YouTube itself. Record backup expiry/restore-replay obligations separately; do not claim those copies were purged without evidence.

Google requires immediate programmatic token revocation on in-app withdrawal, and associated authorized-data deletion as soon as possible and within seven calendar days. User data/account deletion requests also have a seven-calendar-day limit; external Google revocation has a separate thirty-day bound. The candidate uses conservative 28-day maintenance limits. Provider outages and delayed mailbox handling do not extend a policy deadline. [Official YouTube Developer Policies, III.D.2 and III.E.4](https://developers.google.com/youtube/terms/developer-policies).

## Owner sign-off checklist — remaining decisions

- [ ] State the **actual operator/controller**: individual legal name or registered entity, and appropriate business/privacy contact/address. Do not invent a company or assume the Supabase organization name proves one.
- [ ] Name the **primary deletion handler, absence-cover deputy and authorized technical executor**, with authority/access and a daily/weekend rota. Confirm the published email remains the intended monitored intake.
- [ ] Select the **restricted independent request/deletion register**, alert recipient and retention schedule; adopt the above 24-hour acknowledgement / 48-hour internal completion targets, day-3 escalation and seven-calendar-day hard limit, or equally safe alternatives.
- [ ] Confirm the **backup/export/log inventory and managed-copy expiry**, approve the isolated-restore/erasure-replay procedure, and resolve any residual-copy treatment before making compliance claims. Do not simply relabel the seven-day recovery window as guaranteed physical deletion.
- [ ] Approve accurate operator/process wording and a **coordinated migration 0065 + application + legal-page rollout** after the above facts are settled. Old code/UI and current public policies must not be left describing the old behavior after erasure RPC behavior changes.

The implementation supports the proposed process but cannot establish the legal identity, staff the inbox, create an external register or configure alerting by itself. The candidate's vague backup wording still needs the confirmed retention/restore disclosure; its seven-day deletion promise cannot be signed off until the operating process is adopted. No production-readiness certification is implied.
