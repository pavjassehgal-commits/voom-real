# VOOM — eSmart YouTube Compliance Sign-Off

**Prepared:** 31 October 2026 · **Branch:** `codex/youtube-compliance-integration`\
**Status:** AWAITING OPERATIONAL SIGN-OFF — hosted activation and Production release blocked.

Complete the open decisions with real details and evidence. This document does
not authorize deployment, customer deletion or Google verification submission.

## 1. Confirmed facts and boundaries

- **311 focused tests, TypeScript, lint and build passed locally.** No tests repeated here.
- Owner-scoped deletion, access blocking and recovery are implemented. Independent
  capture, completion receipts and failure alerts remain **inactive/unconfigured**.
- Missing capture keeps access blocked and deletion pending. Active erasure,
  Google revocation, backups and request closure are distinct—not assumed successes.
- Published contact: **pavjassehgal@gmail.com**; staffing and legal operator remain unconfirmed.
- YouTube-only erasure preserves original drafts/media, credits and other platforms,
  withdraws YouTube approvals and does not delete YouTube-hosted videos. Existing
  schedules and the 50 MiB uploader are preserved.

## 2. Decisions eSmart must complete

All entries below are **unconfirmed** until an authorized owner supplies them.

| Decision | Required sign-off details |
| --- | --- |
| Legal operator | Actual individual or registered legal entity; jurisdiction; appropriate business/privacy address; accountable privacy contact. |
| Support contact | Confirm the published email is monitored, or approve an established replacement; specify hours and weekend/absence coverage. |
| Primary deletion handler | Name, work contact and authority to register, verify, acknowledge and track requests. |
| Deputy | Name, work contact, access and explicit takeover arrangements for absence or missed alerts. |
| Technical executor | Name, authorized access and responsibility for owner-scoped erasure, revocation verification and restore reconciliation. |
| Escalation owner | Name, direct contact and authority to resolve incidents, deadline risks and residual-copy questions. |
| Independent register | Exact service/private destination and HTTPS ingestion endpoint; service owner; approved processor/location; access list; evidence-retention period. |
| Register recovery | Independent backup/history destination, recovery owner, procedure/objectives and tested recovery evidence; must survive a VOOM restore or primary-record loss. |
| Alert delivery | Exact approved HTTPS receiver, named recipients, delivery/acknowledgment tracking, fallback channel and independent outage/health monitor. |
| Retention and policies | Complete the inventory below; approve restore controls, operational targets and truthful Privacy/Terms/Data Deletion wording. |

Use secure secret entry, **never this document/email/chat**. Require named
least-privilege access, MFA, audit history and independent recovery—not the
application database or a local-only spreadsheet.

## 3. Register, intake and alerts

Record stable request/event IDs, original receipt/deadline, source/scope, verified
owner UUID, verification, assigned people, access-block/erasure/revocation status,
completion evidence and backup obligations. Append corrections; never restart
deadlines. Exclude tokens, passwords, Google IDs, media and raw customer content.

Email intake remains manual: register receipt immediately and verify the correct
owner/scope through established account access, not a sender address alone.

Receivers must persist before acknowledging, deduplicate IDs and separate intent
from completion. Prove recipient delivery and fallback with synthetic events;
an HTTP success or cron 503 does not prove a human was notified.

**Proposed internal targets—require adoption:** acknowledge within 24 hours;
complete within 48 hours; escalate unfinished requests at 48 hours and to the
accountable owner by day 3; urgent review by day 5 and before six-day revocation
credential expiry. Review daily, including weekends. Escalate capture outages,
missing records and deadline risks immediately.

**Applicable YouTube obligations:** in-app consent withdrawal requires immediate
programmatic token revocation and deletion of associated authorized data as soon
as possible, within seven calendar days. User data/account deletion requests also
require applicable stored user data to be deleted within seven calendar days.
Record the original receipt; verification or retries must not reset it. Revocation
through Google settings has a separate thirty-day deletion bound; do not confuse
it with the seven-day cases. These are platform requirements, not the proposed
24/48-hour service targets. [YouTube Developer Policies, III.D.2 and III.E.4](https://developers.google.com/youtube/terms/developer-policies).

## 4. Actual retention inventory — approval required

| Copy | Evidence available | eSmart must provide |
| --- | --- | --- |
| Supabase database backups | Prior inspection on **30 October** recorded daily physical backups, seven accessible daily recovery points and PITR disabled. Not rechecked for this handoff. | Current settings/evidence, actual expiry of managed/residual copies and deletion treatment. Seven accessible days is not a physical-destruction guarantee. |
| Exports/downloads and off-site copies | No complete inventory or verified period. | Every destination, owner, actual period, access and deletion method; explicitly confirm if none exist. |
| Vercel/Supabase/application logs and drains | Actual destinations and retention unverified. | Configured periods, archives/subprocessors, API-data exposure and deletion/expiry evidence. |
| Support email, register and alert evidence | Final retention not approved. | Actual/proposed period for each, legal basis, access, expiry and independent recovery coverage. |
| Storage/cache copies | Database backups cover Storage metadata, not object bytes. | Inventory any API-derived caches separately from original customer media, with periods and deletion treatment. |

Supply dated settings/provider evidence without customer records. Approve minimal
replay retention covering the longest recovery/export horizon plus reconciliation;
do not default to indefinite retention. [Supabase backup documentation](https://supabase.com/docs/guides/platform/backups).

## 5. Keeping deleted data deleted after restore

1. Prove **restore-independent quarantine** blocks YouTube access/workers, old
   deployments and restored schedules. Database barriers alone can roll back.
2. Restore isolated; recover the independent register and verify completeness.
   Replay owner-scoped erasures/exact cutoffs and no-repeat markers using original
   deadlines. Preserve originals/other platforms; do not replay uncertain uploads
   or blindly reuse restored revocation credentials.
3. Independent review and explicit operator approval precede reopening. Missing
   coverage means continued quarantine or separately approved sanitization.

This procedure requires approved controls and testing; it is not an automated guarantee.

## 6. Release authorization gates

**Before hosted staging:** complete sections 2–4; approve receiver/access/recovery
design, supply staging credentials securely and authorize synthetic delivery,
failure/recovery and restore acceptance. No real Google revocation/publication required.

**Before Production:** accept hosted delivery/recovery evidence, adopt retention
and staffed coverage, approve truthful legal wording, then separately authorize
Production preflight/rollout. Local tests alone do not establish operational
compliance or readiness for Google verification. Open items keep release blocked.

**Approval record:** operator name/authority: __________ · operations owner: __________\
Decision/evidence reference: __________ · date: __________\
Stage approved: [ ] synthetic hosted acceptance only [ ] request separate Production approval\
Outstanding exceptions and owner: ______________________________________________

## Technical appendix

- **0065 — data retention:** unchanged underlying access barriers, owner-scoped
  API-data erasure, no-repeat markers and encrypted revocation retry tasks. Retry
  ciphertext expires after **six days**, not seven; expiry is not confirmed Google
  revocation. Historical staging installation is recorded; Production remains
  pending in the release evidence. Verify actual schema before any execution.
- **0069 — independent delivery:** local-only forward migration requiring 0065;
  adds private event/receipt state and database-level capture guards. Not installed
  remotely. The local outbox is not restore-independent. Account deletion involving
  YouTube API data must stage/capture erasure before destructive cascades.
- **Activation order:** approve/provision receivers first; in isolated staging,
  verify existing schema and install only missing 0065, then 0069, coordinated with
  matching application code under YouTube-only maintenance controls. Configure
  journal/alert URLs and dedicated tokens securely, initially inactive; authorize
  `YOUTUBE_DELETION_DELIVERY_APPROVED=true` only for approved receiver testing.
  After hosted acceptance, separately approve Production preflight, targeted
  migrations, matching application/policy release and verified activation. Never
  bulk-push migrations or leave incompatible old clients running. Other platform
  schedules and uploader limits must remain unchanged.
- **Testing:** 311 passes cover failure/recovery, lost/duplicate receipts, ownership,
  restore simulation and uploader compatibility—not external durability, human
  delivery, hosted multi-session races or a real restore.
- **Rollback:** migrations are transactional, one-time installations. After
  erasure, do not restore deleted API data, drop pending receipts/blocks or bypass
  capture to claim success. Prefer a reviewed forward repair or quarantine.
  Rollback/reopening requires separate approval and preserved deletion evidence.

Implementation contract and evidence: `youtube-deletion-delivery.md` and
`youtube-compliance-release.md` in this directory. No Production access, migration,
configuration change, push, merge or deployment was performed for this handoff.
