# YouTube deletion delivery — prepared, NOT activated

Local candidate on `codex/youtube-compliance-integration`. No destination, secret,
environment variable, remote schema or service was configured. **Release remains
blocked by eSmart sign-off and independent receiver acceptance.** A test receipt
is not compliance certification.

## Implemented boundary

- Unchanged 0065 remains the underlying erasure/revocation implementation.
  New **0069_youtube_deletion_delivery.sql** is a forward migration requiring
  0065. It must be reviewed and installed separately; it is not applied anywhere.
- An owner request first commits its access block and local intent. Provider
  clients, publishing and stale-result guards cannot use the blocked grant.
- Erasure requires a separately acknowledged independent intent. SQL wrappers
  enforce this for normal RPC, status, maintenance and account-deletion paths.
  Private pre-delivery functions are not executable by browser or service roles.
  Public function OIDs are preserved so prepared statements cannot bypass guards.
- Missing/unavailable capture keeps the request pending and access blocked. It
  does NOT return deletion success, reset the receipt/deadline, clear the request
  or treat a timeout as a successful external write. Account deletion with stored
  YouTube API data must stage/capture its YouTube erasure first; otherwise the
  transaction is rejected before auth cascades. Account deletion without such
  data is not contingent on a YouTube register.
- Local intent + independent active-erasure completion receipts are distinct.
  Completion failure after local erasure is retried, not reported as full success.
  Neither receipt asserts Google revocation or removal of backup copies.
- Automatic retention stages a fixed cutoff, not a later cutoff recomputed at
  retry. All destructive maintenance is gated. Security expiry of the isolated
  six-day retry ciphertext and expired OAuth-state secrets is still enforced
  during an outage; retaining expired credentials is not a safe fallback.
- Existing authenticated reconciliation cadence retries leased events (same ID,
  immutable body, bounded backoff); no new cron or worker endpoint. A failed purge
  rolls back that owner's changes, retains the intent and stages a failure alert.
  Pending completion/unacknowledged alerts produce operator-attention/503.
- New event table is RLS-enabled and server-only; receipts are written through
  owner/lease-checked functions, not browser writes. Minimal VOOM owner UUID and
  evidence survive full account deletion for replay. These are personal data:
  their final retention requires the real operator's approval. No arbitrary
  public/admin erasure endpoint was added. Normal authorized handlers supply the
  owner from the authenticated session, never a request-body owner override.
- User drafts/media, upload cleanup's 51-hour protection, the 50 MiB limit,
  approvals, credits, other integrations and schedules are unchanged.

## Activation — only after separate approval

Server-only environment names (none set here):

| Name | Required value |
| --- | --- |
| `YOUTUBE_DELETION_DELIVERY_APPROVED` | Literal `true`, only after operator approval and receiver validation |
| `YOUTUBE_DELETION_JOURNAL_URL` | Exact approved public HTTPS ingestion endpoint, independently recoverable from the application DB |
| `YOUTUBE_DELETION_JOURNAL_TOKEN` | Dedicated least-privilege ingestion secret, at least 32 characters |
| `YOUTUBE_DELETION_ALERT_URL` | Approved HTTPS alert receiver with verified routing to named primary/deputy |
| `YOUTUBE_DELETION_ALERT_TOKEN` | Separate least-privilege alert-ingestion secret, at least 32 characters |

No default URL, automatic secret generation or fallback to email/provider exists.
Both endpoints must be configured to authorize new intent capture. Secrets never
appear in browser code, logs, request IDs or errors. URLs reject credentials,
queries, non-HTTPS, nonstandard ports, IP literals and local/internal names;
redirects are forbidden. Endpoints are trusted operator-only configuration, not
user input. eSmart must validate public DNS/ownership and an appropriate egress
allowlist; this adapter does not claim to implement a DNS-rebinding firewall.

## Required receiver contract

1. Authenticate the dedicated bearer credential over HTTPS. Restrict its rights
   to ingestion; no read/list/admin access. Receiver access, backups, audit trail,
   restoration and retention must be independent of VOOM Production restores.
2. Persist the request atomically and durably **before acknowledging**. Deduplicate
   by `Idempotency-Key`; identical ID/body returns the same receipt, a different
   body for an existing ID must be rejected. A delivery receipt from a transient
   queue, a web server 200 or an email API 202 is insufficient.
3. Intent body: `version`, stable `eventId`, minimal `ownerId`, `scope` (`erase` or
   `retention`), original `receivedAt`, applicable `deadlineAt` (seven calendar
   days for erasure; null for routine retention), and exact nullable `cutoffAt`.
   No channel/video IDs, tokens, media, captions, analytics or raw request text.
4. Active-erasure completion uses `<intent-id>:active-erasure`, `requestId`,
   immutable `appliedAt` and `stage=active_erasure` plus the same intent fields.
   Keep Google revocation, backup reconciliation and customer-request closure
   as separately verified operational statuses.
5. Failure alert uses `<intent-id>:<sanitized-code>`, `requestId`, stable
   `receivedAt` and a fixed non-sensitive failure code. The receiver must route
   it to approved recipients, persist delivery/escalation evidence and deduplicate
   retries. No provider/SQL error text is sent. A human reading it is not proven
   by API acceptance alone; monitor/acknowledgment coverage is an external duty.
6. Within eight seconds, return a non-202 success with JSON:
   `{eventId, payloadSha256, durable:true, receiptId}`. SHA-256 covers the exact
   UTF-8 request body. `receiptId` is 1–128 safe alphanumeric/`_.:-` characters.
   Response is capped at 4096 bytes. Invalid/mismatched receipts, redirects,
   timeouts and non-success responses fail closed. Lost acknowledgments retry
   the SAME event, not a new deletion request/deadline.

No receiver or third-party contract is invented by this document. An existing
ticket platform may require an approved adapter/service before it can satisfy
this contract. The local delivery table is an outbox, **not the independent
register**. The HTTP receipt relies on an approved receiver's real durability;
the client cannot establish its backup quality by inspecting a JSON flag.

## Operations still required

- eSmart: real operator/contact, named primary/deputy/executor, weekends/absence
  cover, register owner/access, alert recipients and destination credentials.
- Approve actual backup/export/log inventory and retention, local/external evidence
  retention and residual managed-copy handling. No infinite retention or physical
  purge promise is adopted. No automatic purge of the new journal is enabled
  before that decision.
- Email requests still need human intake, original receipt/deadline, ownership
  verification, independently durable entry and authorized owner-scoped handling.
  This adapter is not a mailbox poller or a ticket UI. Adopt 24-hour acknowledgment,
  48-hour internal target, weekend coverage and deadline escalation externally.
- Add an approved independent dead-man/health monitor. If both delivery sinks or
  the application are unavailable, local pending state/503 cannot itself notify
  anyone or survive a restore. Never claim an alert arrived when it did not.
- Provision and test receiver durability, idempotency, fault recovery and actual
  recipient delivery with synthetic operational events under separate approval.
  Embedded local tests do not prove an external endpoint or live notification.
- Review staged migration upgrade and integrated hosted acceptance before rollout.
  Coordinate 0065, then 0069, application and approved policy release. No bulk
  migration push. Old clients cannot assume disconnect succeeds without capture.
  Preserve existing schedules and all uploader/other-platform configuration.

## Restore and rollback

Keep the existing restore runbook's **external quarantine**: no provider access,
workers or public traffic until journal completeness and replay are independently
verified. Reconcile original external receipt/deadline, scope and fixed cutoff,
not a newly created local request time. The envelope intentionally contains the
minimal information required for that reviewed replay. There is no automatic
restore unlock or privileged public journal-import endpoint in this change.
The local test simulates full-erasure replay only; hosted restoration and exact
retention-cutoff replay remain operator-controlled acceptance requirements.

An absent journal, capture gap or unverified backup coverage means quarantine
continues or a separately authorized sanitize-all-YouTube procedure is required.
Do not blindly reuse restored revocation credentials against a newer grant, replay
uncertain uploads or resurrect deleted API data as a rollback.

0069 installation creates no events or erasures. It is transactional and one-time,
not an idempotent installer. Before activation, failed installation rolls back.
After requests exist, do NOT drop the table/receipts or remove guards to make a
failed deletion look successful. Rollback must preserve pending/completed evidence
and blocks; use a separately reviewed forward repair or quarantine instead.
