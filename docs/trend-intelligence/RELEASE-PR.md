# PR: Trend Intelligence backend (inert by default)

**Branch:** `release/trend-intelligence-backend` → `main` (base `f15b5bc`)

## What ships

- **Migrations** `0055_trend_intelligence.sql`, `0056_trend_mara_workflow_context.sql` and `0057_wikidata_event_source.sql`, byte-identical to the reviewed files (SHA-256 prefixes `93195e8c`, `b5eee7eb`, `4bf4a155`).
  - Already applied and verified on voom-staging.
  - They create only `trend_*` objects; rollbacks are in `supabase/proposed/`.
  - **0052–0054 are left free for the Admin Panel release.** If it ships later, its migrations must be applied with `supabase db push --include-all` (or manually), because they would be older than 0057. The schema is compatible in both orders (tested).
- **Server code:** `lib/trends/**`, flag-gated MARA trend context (`lib/voom/workflow/{prompt,service,trend-flag}.ts`), and AI-layer diagnostics (`lib/ai/*`, defaults unchanged).
- **Daily job route:** `app/api/cron/trend-collection`, with `CRON_SECRET` auth.
- **Scripts:** owner-run staging scripts in `scripts/trends/`.

## Inert by default

- `VOOM_TREND_CONTEXT_ENABLED` unset: MARA prompts and payloads are byte-identical to today's.
- `TREND_COLLECTION_ENABLED` unset: the cron route returns 503 and makes no requests.
- No `vercel.json` change and no schedule.
- No new environment variables are required.

## Tests updated

The migration pin tests now name 0055–0057 as the newest migrations: campaigns v3 (×2), email automation, MARA media brief, multi-social core, post format, post studio (×2), YouTube provider, and the TikTok "no new migration" check. Trend tests build on the 0051 base via `stopBefore: "0055"`.

## Verification (local)

- `npm test`: 1,615 pass, 4 skipped, 1 local-only failure. The failing test compares against a stale local `main` ref (`c75dc75`). Against `origin/main` the only additions are exactly 0055–0057, so it passes.
- `tsc --noEmit` and `next build` succeed.

## After merge (each step separately approved)

1. Read-only check that production is at 0051.
2. Apply 0055 → 0056 → 0057.
3. Run `03-verify.sql`.

Nothing is enabled until the governance records and flags are separately approved.
