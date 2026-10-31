# Production worker scheduling — guarded repository definition

Prepared on `codex/scheduled-worker-config-drift`, based on main `9043131`.
**Repository-only change. No SQL or worker was executed.** Merging this file does
not install a schedule; any database operation needs separate approval.

## Evidence and drift corrected

Saved Production evidence from 30 October (`youtube-performance-timeout-prepared.json`
and the verified job-7 timeout correction) records jobs 1–9 as direct
`net.http_post` calls using Vault **`voom_instagram_cron_secret`**, not a custom
helper. Job #10's subsequent direct-POST correction is confirmed by the owner;
its exact current command/host/timeout was not independently recaptured here.
No live catalog query was performed for this task.

The previous ops file created/referenced `voom_ops.call_worker`, used the different
Vault name `voom_cron_secret`, removed/recreated jobs, and contained stale names
and cadences. The manifest now reflects the saved Production inventory:

| Job name | Schedule (UTC) | Endpoint suffix | HTTP timeout definition |
| --- | --- | --- | --- |
| `voom-instagram-publish-5m` | `*/5 * * * *` | `instagram-publish` | Existing pg_net default, unchanged |
| `voom-media-generation-2m` | `*/2 * * * *` | `media-generation` | Existing default, unchanged |
| `voom-instagram-performance-sync` | `0 */6 * * *` | `instagram-performance` | Existing default, unchanged |
| `voom-email-flows-15m` | `*/15 * * * *` | `email-flows` | Existing explicit 310,000 ms |
| `voom-youtube-publish-5m` | `*/5 * * * *` | `youtube-publish` | Existing default, unchanged |
| `voom-youtube-reconcile-5m` | `*/5 * * * *` | `youtube-reconcile` | Existing default, unchanged |
| `voom-youtube-performance-hourly` | `0 * * * *` | `youtube-performance` | Existing explicit 310,000 ms |
| `voom-tiktok-publish-5m` | `*/5 * * * *` | `tiktok-publish` | Existing default, unchanged |
| `voom-tiktok-reconcile-5m` | `*/5 * * * *` | `tiktok-reconcile` | Existing default, unchanged |
| `voom-instagram-token-refresh-6h` | `41 */6 * * *` | `instagram-token-refresh` | Preserve actual corrected command; 290,000 ms only for an approved new installation |

All endpoints are under `/api/cron/`. Existing secure commands retain their exact
hostname (`voom-real.vercel.app` or `voom.today`), timeout and bytes. New jobs 1–9
use the saved `voom-real.vercel.app` origin; the renewal creation template retains
the original repository's `voom.today` origin/290-second timeout. These defaults
are not claims about the recaptured live job #10. No arbitrary default timeout is
substituted for existing commands. Different current configuration causes a stop,
not an automatic repair. LinkedIn and the daily Vercel jobs stay in `vercel.json`.

## Safe reruns and authorization

- Prerequisites: existing pg_cron/pg_net/Vault objects and exactly one nonempty
  named Vault secret. The script installs no extension, schema or helper and
  changes no privileges/secrets.
- One transaction, three-second lock timeout and 30-second statement ceiling;
  the cron job table is locked against concurrent schedule edits. Any conflict
  rolls back the entire operation, including earlier creations in that run.
- Existing jobs must match the owner/database, active state, cadence and strictly
  parsed direct-POST/Vault command. Mismatched names, aliases, duplicate routes,
  unsupported commands, changed secret references or unexpected timeouts stop.
  A supported job is left **byte-for-byte unchanged**, including its job ID.
- No unschedule, alter, rename, enable, direct row update or deletion is used.
  A missing job also stops by default: the separately approved session setting
  `voom_ops.create_jobs` must list each exact job name allowed to be created,
  comma-separated with no spaces. It is not an authorization bypass; approval and
  Production identity checks must precede any execution. Reset that setting after
  approved use. No wildcard creation option exists.
- Do not rerun the file to "repair" an unexpected state. Capture sanitized
  metadata, compare it, and approve a separate targeted correction. Creating an
  approved missing schedule permits its next natural execution after commit;
  the installer itself never invokes a worker.
- Vault keeps the secret out of the repository and `cron.job`; pg_net's internal
  request queue temporarily contains decrypted headers. Restrict database access
  and never dump Vault values, request headers or raw responses into tickets/logs.

## Offline validation (no database access)

`node supabase/ops/validate-worker-schedules.mjs` checks the repository definition.
Optional `--inventory /absolute/path/catalog.json` compares an already-approved,
non-secret catalog export shaped as `{database, username, jobs:[{jobid, jobname,
schedule, active, database, username, command}]}`. Commands must contain Vault
references, never secret literals. The validator emits metadata/error codes only,
does not connect to a database and does not execute or alter SQL.

`node --test tests/worker-schedules.test.mjs` covers the saved nine-job projection
plus explicitly synthetic renewal cases, drift, helper/credential mistakes,
duplicates, unsupported SQL and rerun preservation. All 27 checks passed, including
the exact-branch Vercel no-deployment guard; existing Vercel settings are unchanged. The
existing renewal suite's stale helper assertion was updated but that DB-backed
suite was not run: its setup executes SQL, prohibited for this task. No runtime
PostgreSQL syntax/locking or live job #10 verification is claimed. Application
build/typecheck are unnecessary for this SQL/docs/JavaScript-only change.

The next step is review of the isolated repository diff, not execution of the ops
file. No migration, application or environment change is required. The sole Vercel
configuration addition sets `git.deploymentEnabled["codex/scheduled-worker-config-drift"]`
to `false`, preventing automatic Preview deployment when publishing this PR branch.
It changes no Production setting, other branch control or cron schedule.

References: [Supabase scheduling and Vault](https://supabase.com/docs/guides/functions/schedule-functions),
[pg_net](https://supabase.com/docs/guides/database/extensions/pg_net),
[pg_cron](https://github.com/citusdata/pg_cron).
