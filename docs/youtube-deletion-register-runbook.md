# YouTube deletion register — release notes and operator runbook

Branch `fix/youtube-compliance-launch`. Code: `workers/youtube-deletion-register/`
(Worker + D1 schema + tests), `lib/youtube/deletion-register.ts` (VOOM side),
`scripts/youtube-register/recover.mjs` (operator recovery). **Nothing is deployed,
no Cloudflare account exists yet, and delivery stays disabled until every
approval below is complete.** This is not a claim of Google compliance.

## 1. Architecture

```
VOOM Production (Vercel + Supabase)                 Cloudflare Workers Free + D1
  0069 outbox ── intent / completion ──▶ POST /v1/events ─▶ register_records (append-only)
              ── failure alert ─────────▶ POST /v1/alerts ─▶ register_alerts ─▶ Resend email
  reconcile cron ── heartbeat + health ─▶ /v1/heartbeat, /v1/health
       └─ register down / watchdog stale / alert undelivered ─▶ Resend email DIRECTLY (fallback)
                                          hourly cron ─▶ watchdog: deadlines, VOOM heartbeat,
                                                         unsent alerts, usage, approved retention
  operator laptop ── replay token ──────▶ /v1/export, /v1/lookup (restore replay / reconciliation)
```

Two independent copies of every deletion record: VOOM's `youtube_deletion_events`
(Supabase) and the register (D1). Losing either one is recoverable from the other.

## 2. Verified Cloudflare facts (official docs, checked 2026-11-01)

| Topic | Fact | Source (last updated) |
|---|---|---|
| D1 Free | 5M rows read/day, 100k rows written/day, 5 GB total, 10 DBs, 500 MB per DB; exceeding daily limits makes queries **error** until 00:00 UTC (no surprise charges) | d1/platform/pricing (Oct 30 2026), d1/platform/limits (Oct 30 2026) |
| D1 recovery | Time Travel always on, point-in-time restore to any minute, **7 days on Free** (30 on Paid); restore overwrites in place | d1/reference/time-travel (Apr 21 2026) |
| D1 concurrency | Each database is single-threaded and processes queries one at a time; a `batch()` runs as one transaction | d1/platform/limits |
| D1 security | Encrypted at rest (AES-256-GCM) and in transit (TLS) | d1/reference/data-security (Apr 21 2026) |
| Workers Free | 100k requests/day (resets 00:00 UTC; error 1027 beyond), 10 ms CPU per request, 50 subrequests, **5 Cron Triggers per account** | workers/platform/limits (Oct 29 2026) |
| Cron | UTC schedules; changes take up to 15 min to propagate; last 100 runs visible; **no documented retry or failure notification** | workers/configuration/cron-triggers (Oct 17 2026) |
| Secrets | Encrypted; not visible in dashboard/Wrangler after being set | workers/configuration/secrets (Oct 15 2026) |
| Audit | Account audit logs on all plans, 18 months retention (which Workers/D1 actions are logged is not documented) | fundamentals audit logs (Apr 22 2026) |

**Not documented, so not assumed:** D1's replication or durability guarantees, cron
retry behaviour, and whether a Free account needs a card. The design covers the first
two (dual copies, cross-heartbeat). The third is confirmed when the account is created.

## 3. Guarantees and how they are enforced

- **Never a false acknowledgement.** The Worker answers 200 only after the D1
  transaction commits and it has read back the stored fingerprint. Every error
  (validation, auth, D1 outage, Free-limit exhaustion, Workers error 1027) is non-2xx.
  VOOM's existing 0069 code then keeps the user blocked and retries with the same
  event id and original deadline (verified on hosted staging and in local tests).
- **Idempotent and tamper-resistant.** The event id is the primary key, and the receipt
  is deterministic from (id, fingerprint), so repeated or lost-response deliveries get
  the same receipt. A different payload under an existing id gets 409 and is never
  overwritten. SQL triggers make records append-only. Alerts are immutable apart from
  their email bookkeeping. Deletion is possible only inside the transaction-scoped
  retention gate. A weekly reconcile compares VOOM's receipts and fingerprints with
  the register, which gives tamper evidence across two separate providers.
- **Minimal data.** The schema and the exact-field validation reject anything beyond
  event/owner UUIDs, scope, timestamps, fingerprints and receipts. Tokens, channel or
  video IDs and email addresses are refused (tested). Alert emails contain no owner id.
- **Authentication.** Three separate bearer tokens (journal, alert, replay; at least
  32 characters), compared in constant time. Each has a `*_NEXT` slot for rotation
  without downtime. The replay token lives only with the operator, never on Vercel.
- **Retention.** `RETENTION_DAYS` is unset, so **nothing is ever purged** until an
  approved period is configured. Values under 30 make the cron run fail visibly. An
  approved purge removes only completed requests whose completion is older than the
  period; open requests are never purged.

## 4. Configuration required (owner actions — not done)

1. Cloudflare account (Free) with 2FA enforced; members limited to named operators.
2. `wrangler d1 create voom-youtube-deletion-register` → put the id in `wrangler.toml`;
   `wrangler d1 execute voom-youtube-deletion-register --remote --file schema/0001_register.sql`.
3. Secrets: `wrangler secret put` JOURNAL_TOKEN, ALERT_TOKEN, REPLAY_TOKEN (each `openssl rand -hex 32`),
   RESEND_API_KEY (a **send-only** Resend key).
4. Vars in `wrangler.toml`: ALERT_FROM / ALERT_TO = `no-reply@voom.today`, the owner's
   monitored Google Workspace inbox. ALERT_ESCALATE_TO stays empty until a second person exists.
5. `wrangler deploy` (Workers Free). Note the `*.workers.dev` URL.
6. Vercel **Production** env: `YOUTUBE_DELETION_DELIVERY_APPROVED=true`,
   `YOUTUBE_DELETION_JOURNAL_URL=https://<worker>/v1/events`, `YOUTUBE_DELETION_JOURNAL_TOKEN`,
   `YOUTUBE_DELETION_ALERT_URL=https://<worker>/v1/alerts`, `YOUTUBE_DELETION_ALERT_TOKEN`,
   `YOUTUBE_DELETION_FALLBACK_ALERT_TO` (operator inboxes; uses VOOM's existing Resend config).
7. After the first VOOM heartbeat is seen, set `REQUIRE_VOOM_HEARTBEAT = "true"` and redeploy.

**Expected cost: $0.** Usage is far below the limits: a few deletion events per day,
about 24 heartbeats, and 24 cron runs, so well under 1% of either Free daily limit.
Resend is already part of VOOM. This assumes Cloudflare doesn't require a paid plan at
signup; confirm when creating the account.

## 5. Safe deployment order

1. Deploy the Worker **staging copy** (a separate D1 database and separate tokens). Point
   staging VOOM env at it, re-run the hosted staging acceptance with the real register,
   prove a real alert email arrives, then delete the synthetic data.
2. Deploy the Production Worker and D1, then verify `/v1/health` (watchdog ran).
3. Production preflight (read-only), then apply **0065**, then **0069** (as on staging).
4. Set the Vercel env (step 4.6) **in the same release** as the app deploy containing this branch.
   With 0069 installed and delivery disabled, disconnects stay pending, so never leave
   that gap open.
5. Verify heartbeat → enable `REQUIRE_VOOM_HEARTBEAT`; run `recover.mjs reconcile` (expect 0 missing).

## 6. Runbook — what to do when…

| Alert / symptom | Meaning | Action |
|---|---|---|
| `destination_unavailable` / `capture_failed` | Register unreachable or non-durable | Check `/v1/health` and Cloudflare status. The user stays blocked. Once the register is healthy, VOOM retries automatically; confirm the event gets `recorded_at`. |
| `erasure_failed` | DB purge rolled back | Inspect the VOOM event (by id). Maintenance retries; if it keeps failing, fix the cause, then let maintenance re-run. Never unblock manually. |
| `deadline_day3` / URGENT `deadline_day5` | No completion recorded | Find the request in D1 (`select * from register_records where request_id = ?`) and in VOOM. Drive it to completion; escalate on day 5. The deadline is 7 days from the original receipt. |
| `heartbeat_missing` | VOOM cron not reaching the register for >26h | Check Vercel cron logs and the reconcile route. Deletions may be stalled. |
| Fallback email `register_unreachable` / `register_watchdog_stale` | Register or its cron down | Check Cloudflare, redeploy the Worker, check Past Cron Events. |
| `usage_warning` (50/80%) | Approaching Free daily writes | Investigate unusual traffic. If legitimate, upgrade to Workers Paid (limits lift within minutes). |
| **Main Supabase restored** | Deletions after the backup are lost | 1. Keep YouTube crons/publishing disabled. 2. `recover.mjs replay --restore-point=<backup time> --approved`. 3. Run maintenance once. 4. Check `failed: []`. 5. Re-enable YouTube. |
| **D1 restored / lost** | Recent register records missing | `recover.mjs reconcile --approved` re-sends with the same ids; investigate any `conflicts`. |
| Token suspected leaked | — | Put the new value in `*_NEXT`, deploy, switch Vercel to the new token, then move it into the primary slot and remove `*_NEXT`. |

## 7. Known limitations (honest)

- **Free request quota can be exhausted by abuse.** Unauthenticated floods to the public
  `workers.dev` URL count toward the 100k requests/day (WAF rate limiting needs a
  Cloudflare-proxied zone). Effect: the register refuses requests until 00:00 UTC.
  Deletions stay safely blocked, not lost; VOOM's fallback email fires. Mitigations: an
  unguessable Worker name; a one-click upgrade to Workers Paid; at most a 24h delay
  against a 7-day deadline.
- **Time Travel covers 7 days on Free.** Longer-term recovery relies on the VOOM copy
  (reconcile). A simultaneous loss of both Supabase and D1 is not covered.
  Optionally keep a monthly `wrangler d1 export` in encrypted operator storage.
- **Cron has no documented retry.** This is covered by the cross-heartbeat (VOOM alerts
  when the watchdog is over 2h stale).
- **Audit coverage of D1 queries** by dashboard users is not documented. The
  append-only triggers plus cross-provider reconciliation provide tamper evidence.
- **Restores resurrect deleted Supabase auth accounts too.** Replay covers YouTube
  data; account deletion replay is a separate (non-YouTube) procedure.
- **Validation level:** local real-D1 (workerd) and embedded-Postgres tests, plus the
  earlier hosted staging run. A hosted run against a real Cloudflare deployment, with a
  real email, is still required (deployment order, step 1).

## 8. Alert monitoring and backup (single owner)

1. **Primary:** the register emails `no-reply@voom.today` through its own send-only Resend key.
   A Gmail filter on `[VOOM YouTube deletion` stars and labels these alerts, never sends them to spam, and
   notifies the owner's phone. Staging subjects say `STAGING`; Production subjects carry no label.
2. **Backup email:** the VOOM app checks the register every maintenance run. If the register
   is unreachable, its watchdog is stale, or alert email is stuck, the app sends an `URGENT`
   email through VOOM's own Resend key (`YOUTUBE_DELETION_FALLBACK_ALERT_TO`). This uses a
   different system and a different key.
3. **Weekly manual check (2 minutes, every Monday):** Cloudflare dashboard → Storage & Databases → D1 →
   `voom-ydr-production` → Console:
   `select count(*) from register_alerts where email_status = 'pending';` must be 0, and
   `select last_seen_at from register_heartbeats;` must show both rows within the last day.
   A non-zero or old value means: follow section 6.
4. **Away for more than 3 days:** hand the inbox to a trusted person, or check the label daily.
   Erase deadlines are 7 days, and the day-3 and day-5 alerts exist for exactly this.
5. **Residual risk:** both email paths use Resend. A full Resend outage is caught by the weekly check.

## 9. Remaining approvals

Owner only: the Production rollout, the retention period (unset = keep the minimal records),
and the Google OAuth verification steps in `youtube-google-verification-package.md`.
