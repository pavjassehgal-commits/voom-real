# Native Marketing Plan video generation

TikTok Video and YouTube Shorts plan cards use the existing video engine, private
`mara-media` bucket, polling worker and 40-credit video ledger. Long-form YouTube
and Instagram's existing generation/approval paths are unchanged.

## Safety boundary

- Authenticated, same-origin POSTs select an owned **draft UUID**, not a date.
  Both composite plan identities and valid legacy date keys are supported.
- The existing entitlement guard reserves 40 credits before paid work. Migration
  0063 atomically reserves the active generation before prompt/base-image work;
  concurrent starts cannot submit a second provider job. One click identity is
  reused after an ambiguous network response. A new explicit retry has a new
  identity and its own reservation; existing refund/settlement rules apply.
- Ambiguous provider submission (timeout/5xx/malformed response), or lost database
  persistence after acceptance, keeps its reservation and blocks another paid
  submission. Manual provider reconciliation is required if no handle can be
  recovered; the app never invents a refund or resubmits blindly.
- Already claimed/submitted/published social jobs block replacement. Unclaimed
  approved work is withdrawn before generation, without altering copy or time.
- Completion atomically attaches validated vertical MP4 bytes to the same owned
  draft and marks the job complete. Native output is 4–15 seconds and at most
  20 MiB (the existing private asset limit). Invalid output retains the old asset.
- Completion always leaves a draft for review—even for Max/Autopilot. It never
  approves, queues or publishes. TikTok requires fresh preview/creator settings,
  disclosures and per-post consent. Generated Shorts require a fresh explicit
  synthetic-content answer; existing privacy/audience choices are retained.
- The existing worker advances/reconciles paid native jobs, but deliberately
  skips Instagram's completion/calendar/automatic-approval callback.

## Migration and release

`0063_native_plan_video_generation.sql` is local only. It adds three service-only
helper/RPC functions and one approval-enforcement trigger function/trigger; no new
tables, columns, backfill, cron, credentials or deployment settings are required.
It depends on existing native queues, credit/job tables and 0059 version guards.
Apply it **only after separate staging approval**, before testing the new routes.
The transactional DDL briefly locks drafts; normal function calls lock one owned
draft and its native queue rows. Do not execute a bulk migration push.

Before production: validate migration and controlled two-session races on isolated
staging, then separately authorize one paid generation on each platform. Local
tests use real embedded PostgreSQL and fake providers/storage; they do not prove
live-provider output/playback. No migration, paid call or deployment was executed
as part of implementation. The feature branch disables automatic Vercel deploys.

## Focused checks

New suites: `tests/native-plan-video-generation.test.mjs` and
`tests/native-plan-video-ui.test.mjs`. They cover ledger/attachment/idempotency,
tenant/plan restrictions, failed starts/output, publishing/approval races, native
worker review-only behavior and responsive real-component browser interactions.
Existing video, credit, Marketing Plan, TikTok and YouTube suites must also pass.
