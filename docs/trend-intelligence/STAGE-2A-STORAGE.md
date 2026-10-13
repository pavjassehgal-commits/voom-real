# Voom Trend Intelligence — Stage 2A secure storage

Status: **proposed migration, tested locally only.** It has not been applied to any remote database (staging or production). It is not in `supabase/migrations`, so nothing schedules or deploys it. Nothing writes to it yet: there is no ingestion, no API connection, no credential and no worker.

Files:

- `supabase/proposed/trend_intelligence_storage.sql` — the migration (unnumbered)
- `supabase/proposed/trend_intelligence_storage.rollback.sql` — rollback
- `tests/trends-storage-migration.test.mjs` — 28 PGlite tests

## 1. Tables

| Table | Purpose | `service_role` |
| --- | --- | --- |
| `trend_sources` | Mirror of the Stage 1 source registry (platforms, subject kinds, language scope, evidence-URL rule, retention cap: YouTube 30 days, others 365). A test fails on any drift from `lib/trends/types.ts`. | SELECT |
| `trend_metric_definitions` | Metric versions: unit, bounds, integer rule, required flag, `[effective_from, effective_until)`. | SELECT |
| `trend_source_authorizations` | Owner decision per source: status, decided_at, decided_by, reference. Approved/not-approved need time and decider; approved needs a reference. No row = not reviewed. | SELECT |
| `trend_source_coverage` | Per source × platform × country: verified / unavailable / unverified, checked_at, evidence. | SELECT |
| `trend_observations` | Validated observations. Identity keys are database-generated. Has freshness timestamps (`fresh_until`, `stale_after`, `expires_at`, `freshness_basis`) and `delete_after`. | SELECT, INSERT |
| `trend_observation_metrics` | One row per metric: status, value (exact `numeric`), unit, definition version, unavailable reason. | SELECT, INSERT |
| `trend_evidence` | Attribution, optional https URL, retrieval time. | SELECT, INSERT |

`trend_sources` and `trend_metric_definitions` are additions to the five requested tables. They are reference data. Without them, the database could not enforce source capabilities, retention caps or metric definitions on its own.

## 2. Security model

- **RLS** is enabled on all seven tables, with **zero policies**.
- **Privileges:** everything is revoked from `public`, `anon` and `authenticated`. The test first reproduces Supabase's default grants to new objects, then proves the migration removes them.
- **`service_role`** gets only the grants in §1. It has no UPDATE, DELETE or TRUNCATE on any table, and it cannot write authorizations or coverage. Only the owner can approve a source or verify coverage.
- **Functions:**
  - The trigger functions are not executable by any API role.
  - The purge function is the only callable function: `service_role` only, `SECURITY DEFINER`, fixed `search_path`. It uses the database clock, so a caller cannot purge early.
- **No merchant or customer data:** there are no user, business, email or name columns. The only foreign keys point to the trend tables themselves.

## 3. Integrity rules (enforced by the database)

- **Storage gate:**
  - the source must be `approved`;
  - coverage must be `verified` for the exact (source, platform, country);
  - platform, subject kind and language scope must be ones the source supports.
- **Identity:**
  - `item_key`, `topic_key` and `trend_key` are generated columns; callers cannot supply them;
  - `(source, trend_key, window_start, window_end)` must be unique;
  - provider-ID rules follow the subject kind and platform, as in Stage 1;
  - country and language are part of `trend_key`.
- **Immutability:**
  - UPDATE is blocked by trigger on observations, metrics and evidence, even for the owner;
  - metrics and evidence can only be inserted in the same transaction that created their observation;
  - a deferred check at commit requires at least one evidence row and every *required* metric (measured or explicitly unavailable).
- **Metrics:**
  - the metric must belong to the source and use the definition's unit;
  - a measured value needs a definition version that exists for that metric and was in force at retrieval, and it must respect min/max and the integer rule;
  - NaN and Infinity are rejected;
  - an unavailable metric has no value and no version, and must give a reason — it can never become 0.
- **Evidence:**
  - it must come from the same source;
  - the URL is required where the source requires one, and must be https without credentials;
  - attribution cannot be blank.
- **Retention:**
  - `delete_after` is mandatory, later than retrieval, and in the future at insert;
  - it is capped at the source's limit (YouTube ≤ 30 days after retrieval);
  - a retrieval time in the future is rejected.
- **Purge:**
  - `trend_purge_expired(p_limit)` takes a limit of 1–1000;
  - it deletes the oldest deadlines first and uses `skip locked`;
  - metrics and evidence are removed by cascade.

## 4. Retention enforcement is not active

The purge function exists but **nothing calls it**: there is no `pg_cron` job, Vercel cron or worker. **Before any real ingestion is enabled**, an execution mechanism must be approved. Options:

- a database-only `pg_cron` schedule;
- an operator-run schedule with monitoring.

The 30-day YouTube limit applies even if ingestion stops, so the purge must keep running independently of ingestion.

## 5. Migration numbering

- `origin/main` is still `f15b5bc` and ends at `0051_ai_request_rate_limits.sql`.
- The Admin Panel worktree holds unmerged local `0052`–`0054`, and its branch also edits the repository's "newest migration" pin tests.
- Taking `0052` would collide with the admin work.
- Taking `0055` now has two problems:
  - deployed before the admin migrations, it would create an out-of-order history;
  - it would require editing the same nine pin tests, causing merge conflicts.
- **Resolution:** the file stays unnumbered in `supabase/proposed/`. At integration it gets the next free number after whatever has landed on `main`, which is `0055` if the admin release goes first. The pin tests are updated in that same reviewed change. Nothing in `supabase/migrations` changed, and the existing pin tests still pass.

## 6. Known limits

- Authorization and coverage changes are not historized: one current row is kept per key. An append-only decision history is recommended before production.
- Revoking a source does not delete data already stored from it. The Stage 2B read model must re-check current authorization and coverage on every read.
- Metric versions are chosen by timestamp. The exact cut-over instant of the YouTube 2026-08-24 change is assumed to be midnight UTC.
- The database does not check whether a YouTube evidence URL matches the video ID. The Stage 1 validator still does this before insert.
- `subject_normalized` is supplied by the app's Stage 1 normalizer. The database only checks lower-case, trimmed form and length.
- The tests use PGlite (PostgreSQL 18, WASM). Supabase behavior is reproduced, not exercised.
