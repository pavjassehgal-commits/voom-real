# Voom Trend Intelligence — Stage 1 review and Stage 2 proposal

Status: **proposal only — no Stage 2 code, migration, credential or provider call exists.**

> **Stage 1.5 update:** provider identity, the five-fact source registry, the Google Trends split and the YouTube activation prerequisites are in `STAGE-1.5-CORRECTIONS.md`, which supersedes §4.1, §4.3 and §4.7 below. Stage 2 now starts with Stage 2A (storage only).
Prepared 2026-10-11 on branch `local/voom-trend-intelligence` (base `origin/main` `f15b5bc`).

## 1. Inputs reviewed

| Input | Result |
| --- | --- |
| Codex "Voom Trend Intelligence — Phase 1 Backend Audit" | **Found and reviewed** (Codex session log, 2026-10-11 05:01 UTC; audit basis `f15b5bc`, same as this branch). Stage 1 follows its "Stage 1 — Pure trend domain" plan and the five proposed `lib/trends/*` files. |
| Voom backend (`f15b5bc`) | Inspected: MARA planner (`lib/voom/workflow/{prompt,service}.ts`), performance context (`lib/performance/*`), YouTube client (`lib/youtube/client.ts`, `config.ts`), cron/auth patterns (`app/api/cron/*`, `utils/bearer-auth.ts`), rate limiting (`lib/rate-limit.ts`, migration 0051), migration conventions. |
| Official YouTube documentation | Read (public docs only, no API calls): `videos.list`, `videos` resource, Getting Started (quota), `i18nRegions.list`, YouTube API Services Developer Policies. Findings in §3. |

## 2. Stage 1 final state (decisions applied 2026-10-11)

**Decision 1 — freshness (provisional product defaults, not provider rules).** Age = `now − window.end`:

| State | Boundary |
| --- | --- |
| fresh | `0 ≤ age ≤ freshFor` |
| aging | `freshFor < age ≤ staleAfter` |
| stale | `staleAfter < age ≤ expiresAfter` (usable, weak) |
| expired | `age > expiresAfter` (never used) |

Defaults: Google Trends 3 / 7 / 30 days; YouTube chart 1 / 3 / 7 days; manual research 7 / 14 / 30 days. Exported as `FRESHNESS_POLICY_BASIS = "provisional_product_default"`; any call may pass a validated override.

**Decision 2 — markets.** `TARGET_MARKETS` lists the eleven intended markets exactly as decided. A strict language-tag registry (`TREND_LANGUAGES`: en, ar, hi, zh-Hans, zh-Hant, tr, ms, id, th, vi, fil, plus `und`) replaced two-letter ISO 639-1 codes, which could not represent Simplified vs Traditional Chinese or Filipino. Availability is **not** assumed: a `SourceCoverage` entry per source × platform × country must be `verified` (with `checkedAt` and evidence) before any observation counts. `DEFAULT_SOURCE_COVERAGE` is empty, so today every market is "coverage unverified" and confidence is `insufficient` everywhere.

Tests: 50/50 (`tests/trends-schema.test.mjs`, `tests/trends-processing.test.mjs`); typecheck and lint clean.

## 3. YouTube Data API — verified facts and constraints

| Topic | Official documentation says | Consequence |
| --- | --- | --- |
| Endpoint | `videos.list` with `chart=mostPopular` returns "the most popular videos for the specified content region and video category". | Feasible first source. |
| Region | `regionCode` = ISO 3166-1 alpha-2, only with `chart`. | Matches our `country`. |
| Category | `videoCategoryId` default `0` (not restricted). | Start unrestricted. |
| Page size | `maxResults` 1–50, default 5. | One page of 50 per market. |
| Quota cost | `videos.list` costs **1 unit**; **every request, including invalid ones, costs at least 1 unit**. | Reserve budget *before* each request. |
| Default quota | **10,000 units/day** for most endpoints. | Voom budget well below this. |
| Statistics | `viewCount`, `likeCount`, `commentCount` (unsigned long). `dislikeCount` private since 2021. `favoriteCount` deprecated since 2015 and **always 0**. | Never ingest `favoriteCount`/`dislikeCount` (fabricated/unavailable zero). |
| View definition | From **2026-08-24**, `viewCount` counts a view "the moment a video begins to play". | Store a metric-definition version; never compare counts across that date. |
| Region list | `i18nRegions.list` returns supported content regions (1 unit). The docs page does **not** list codes. | Coverage must be verified with a real call before any market is enabled. |
| Storage (Developer Policies III.E.4) | Non-authorized data may be stored "not longer than 30 calendar days"; after that "delete or refresh". | Hard retention limit ≤ 30 days on YouTube rows, enforced in the database. |
| Derived data (III.E.4.h) | Must not "use API Data to create new or derived data or metrics". | **Blocking question** — see §4.1. |
| Aggregation (III.E.2) | Must not aggregate API data "to gain insights into YouTube's usage…". | **Blocking question** — see §4.1. |

Not confirmed by the pages read: whether an API key alone suffices for `chart=mostPopular` (the docs say unauthorized list requests return public data, but the method page does not state it explicitly), the quota reset time zone, and whether the `X-Goog-Api-Key` header is accepted (preferred so the key never appears in URLs or logs). All three are verified in Stage 2c with a staging-only key before enabling anything.

## 4. Unresolved questions (need decisions before or during Stage 2)

1. **YouTube policy fit (blocking for ingestion).** Turning chart data into "trends" and confidence categories may be "derived data" (III.E.4.h) or "insight into YouTube's usage" (III.E.2). Needs policy/legal review. Mitigation in this design: store and present YouTube values verbatim with attribution, compute no metric from them, and keep confidence evidence-count based. Persistence (2a/2b) can proceed; the YouTube adapter must not be enabled until this is answered.
2. **30-day deletion without background workers.** The policy needs deletion even if no ingestion runs. Options: (a) a database-only `pg_cron` purge (no HTTP, no app worker), or (b) an operator-run purge with a documented schedule. Recommended: (a).
3. **[Resolved in Stage 1.5]** **Stage 1 amendment — provider identity (correctness).** Stage 1 identifies a subject by normalized text. Two different videos with the same title in the same window would be treated as duplicates. Add an optional `subject.providerRef` (e.g. the video id) used in observation identity when present, and an optional provider timestamp (e.g. `snippet.publishedAt`) on evidence. Small, but a Stage 1 change; needs approval.
4. **Migration numbering.** `main` ends at 0051; the Admin Panel worktree holds unmerged local 0052–0054. The trend migration takes its number when it is integrated (tentatively after the admin migrations), and the nine "newest migration" tests on `main` need the same explicit update the admin release used.
5. **Merchant market.** `businesses` has a timezone but no country/language. Matching trends to a merchant (a later stage) needs an approved market field; not part of Stage 2.
6. **China.** No registered source covers mainland China (Douyin/Weibo/Xiaohongshu are not registered; TikTok is not Douyin). CN stays coverage-unverified/unavailable until a compliant mainland source exists.
7. **Google Trends.** [Updated in Stage 1.5] Split into `google_trends_web` (no public API; manual, 0–100 per request) and `google_trends_api` (restricted alpha, consistently scaled, not 0–100). No scraping; no connection.
8. **Subregions** (e.g. Indian states) and further languages (Singapore Tamil, Malaysia Mandarin, per the audit) are out of scope until a source provides them.

## 5. Stage 2 proposal

Delivered in four separately approved steps. Nothing is scheduled, nothing touches MARA, and everything ships disabled.

### 5.1 Exact files

| Step | File | Purpose |
| --- | --- | --- |
| 2a | `supabase/migrations/00NN_trend_intelligence_core.sql` | Service-only tables and functions (§5.2). Number assigned at integration (§4.4). |
| 2a | `tests/trends-storage-migration.test.mjs` | PGlite tests of the real migration (§5.4). |
| 2a | 9 existing migration-pin tests | Name the new migration explicitly (same pattern as the admin release). |
| 2b | `lib/trends/storage.ts` (server-only) | Validated observation ⇄ row mapping; bounded read model (`listUsableObservations(platform, market, now)`); never returns expired or uncovered rows. |
| 2b | `lib/trends/coverage-store.ts` (server-only) | Loads `trend_source_coverage` into a Stage 1 `MarketPolicy`. |
| 2b | `lib/trends/ingestion.ts` (server-only) | `runTrendIngestion({ adapter, sourceId, platform, market, now, deps })`: claim run → reserve quota → fetch → `parseTrendObservations` → `dedupeObservations` → insert (idempotent) → finish run. All failures classified; raw provider errors never stored or returned. |
| 2b | `lib/trends/adapters/types.ts` | `TrendSourceAdapter` interface (from the audit): `capabilities()`, `fetch(market)` → raw observations + quota units used. |
| 2b | `tests/trends-ingestion.test.mjs` | Ingestion with a fake adapter and PGlite (§5.4). |
| 2c | `lib/trends/config.ts` (server-only) | Reads `TREND_INGESTION_ENABLED` (default off), `TREND_YOUTUBE_API_KEY`, `TREND_YOUTUBE_DAILY_UNIT_BUDGET` (default 200), `TREND_OPERATOR_SECRET`. Returns null (no requests) when disabled or incomplete. |
| 2c | `lib/trends/adapters/youtube-popular.ts` (server-only) | Key-based `videos.list?chart=mostPopular&regionCode=XX&part=snippet,statistics&maxResults=50`; key in a header; timeout; maps rank (response order), view/like/comment counts (unsigned-long strings parsed exactly; absent → `unavailable/not_provided_by_source`), title (untrusted text), video id, evidence URL `https://www.youtube.com/watch?v=<id>`, attribution "YouTube", `language: "und"`. Separate from the merchant OAuth client; reuses only its error-reason classification pattern. |
| 2c | `tests/trends-youtube-adapter.test.mjs` | Provider-shaped fixtures only; `fetch` replaced; no network (§5.4). |
| 2d | `app/api/internal/trends/ingest/route.ts` | Manual operator trigger: `POST`, bearer `TREND_OPERATOR_SECRET` (constant-time `bearerMatches`), 404/503 when disabled, `no-store`, counts only. **Not** in `vercel.json` or Supabase Cron. |
| 2d | `tests/trends-ingest-route.test.mjs` | Route behavior (§5.4). |
| 2d | `.env.example` | Document the four variable names (no values). |
| all | `docs/trend-intelligence/*` | Runbook, coverage-verification procedure, rollback. |

No file under `app/app`, `components`, `lib/mara`, `lib/voom`, `lib/youtube`, admin or auth paths changes.

### 5.2 Database changes (one additive migration)

All tables: RLS enabled, **no policies**, all privileges revoked from `public`, `anon`, `authenticated` (and Supabase's default sequence grants revoked). Global, non-merchant data: **no `owner_user_id`, no business ids, no merchant content**.

| Object | Key columns / rules | `service_role` access |
| --- | --- | --- |
| `trend_source_coverage` | `source_id`, `platform`, `country`, `status` (verified/unavailable/unverified), `checked_at`, `evidence`, `checked_by`; unique (source, platform, country); check: verified/unavailable require `checked_at` + `evidence`. | SELECT only (owner records checks). |
| `trend_ingestion_runs` | `id`, `source_id`, `platform`, `country`, `language`, `request_fingerprint` (unique: source + platform + market + retrieval bucket), `status` (claimed/succeeded/failed/skipped_quota/skipped_disabled/skipped_unverified), `attempt` (≤ 3), counts (received/stored/duplicates/rejected), `quota_units_reserved/used`, `failure_code` (code pattern only), timestamps. No payloads, no URLs with keys. | via RPCs only. |
| `trend_observations` | Validated Stage 1 fields: `source_id`, `platform`, `country`, `language`, `subject_kind`, `subject_text` (≤ 200), `subject_normalized`, `provider_ref`, `window_start/end`, `retrieved_at`, `metrics` (jsonb object, Stage 1 shape), `metric_definitions_version`, `expires_at`, `delete_after`, `observation_identity` (**unique**), `payload_digest`, `ingestion_run_id`. Check: for `youtube_data_api`, `delete_after ≤ retrieved_at + 30 days`. Immutable (trigger blocks UPDATE). | INSERT (`on conflict do nothing`), SELECT. |
| `trend_evidence` | `observation_id` (cascade), `source_id`, `url` (https check), `attribution`, `retrieved_at`, `provider_published_at`. Immutable. | INSERT, SELECT. |
| `trend_provider_quota` | `source_id`, `quota_day` (UTC), `units_budget`, `units_reserved`, `units_used`; check reserved ≤ budget. | via RPC only. |
| `trend_claim_ingestion_run(...)` | SECURITY DEFINER, fixed `search_path`: idempotent claim by fingerprint; returns existing run if succeeded; allows a retry of a failed run while `attempt < 3`. | EXECUTE. |
| `trend_reserve_quota(source, day, units)` | Atomic reserve; refuses beyond budget. | EXECUTE. |
| `trend_finish_ingestion_run(...)` | Sets terminal status and counts once. | EXECUTE. |
| `trend_purge_expired(now)` | Deletes observations past `delete_after` (bounded batch); returns count. | EXECUTE; plus optional `pg_cron` schedule if §4.2(a) is approved. |

Rollback: drop the functions, then the tables (no other object depends on them); documented and tested like the admin migrations.

### 5.3 Quota, cost, duplicates and retries

- **Budget:** Voom's own daily budget per source (default 200 of YouTube's 10,000 units), reserved atomically *before* each request because invalid requests also cost quota. One run = one market = one `videos.list` page of 50 → 11 units for all target markets.
- **Errors:** `quotaExceeded`/`dailyLimitExceeded` → stop, `skipped_quota`, no retry that day. `rateLimitExceeded`/429/5xx → at most 2 retries with backoff inside the run. 400/403 config errors → `failed`, no retry. Malformed responses store nothing.
- **Duplicates:** run fingerprint (same source + market + retrieval bucket) makes repeat triggers return the existing run. `observation_identity` uniqueness makes replays insert nothing. A replay with the same identity but a different `payload_digest` is rejected and counted, never overwritten.
- **Coverage gate:** a run for a market whose coverage is not `verified` records `skipped_unverified` and makes no request.
- **Isolation:** no merchant data is read or sent; MARA is not called; nothing is scheduled.

### 5.4 Test cases

**Migration (PGlite, real SQL):** RLS on and zero policies on every trend table; `anon`/`authenticated` denied all reads/writes/RPCs; `service_role` limited to the grants above; observations immutable; unique identity enforced; YouTube `delete_after` > 30 days rejected; verified coverage without evidence rejected; quota reserve never exceeds budget; run claim idempotent; retry capped at 3; purge deletes only rows past `delete_after`; no `owner_user_id`/merchant column exists; customer RLS unchanged (a customer still sees only their own business); rollback SQL runs and the migration re-applies.

**Ingestion (fake adapter + PGlite):** disabled config → no adapter call; unverified coverage → `skipped_unverified`, no call; quota exhausted → no call; valid batch stored with attribution; invalid items rejected and counted, never stored; duplicate replay stores nothing; conflicting replay rejected; adapter throws → run `failed`, no partial rows; re-trigger same bucket → same run; expired rows never returned by the read model; uncovered rows never returned; no MARA/merchant table touched.

**YouTube adapter (fixtures, no network):** request shape (endpoint, `chart=mostPopular`, `regionCode`, `part`, `maxResults=50`, key only in header); rank from response order; counts parsed exactly from strings; missing `likeCount`/`commentCount` → unavailable (never 0); `favoriteCount`/`dislikeCount` ignored; unsafe-integer counts rejected; prompt-injection titles stored as inert text; error reasons → kinds (quota vs rate limit vs config); timeout; malformed JSON → nothing stored; unsupported/unverified region → no request; the key never appears in errors, logs or returned data.

**Route:** 404/503 when disabled; 401 without the operator secret (constant time); `no-store`; counts-only response; no secrets or provider bodies in responses; not present in `vercel.json` or cron SQL.

### 5.5 Rollout safeguards

1. Ship with `TREND_INGESTION_ENABLED` off and no key configured: nothing can run.
2. Resolve §4.1 (policy review) before any YouTube key is created for Voom.
3. Staging first, with a **staging-only** Google Cloud project, key and low budget; verify API-key auth, header support and quota behavior there.
4. Verify coverage per target market with `i18nRegions.list` and record each result (verified/unavailable, timestamp, evidence) in `trend_source_coverage`; CN expected to remain unavailable/unverified.
5. Enable markets one at a time; review run records after each manual trigger.
6. Decide the purge mechanism (§4.2) before the first stored YouTube row.
7. MARA stays untouched in Stage 2; trend data has no consumer yet (audit Stages 6–7: shadow mode, then controlled planning integration).
8. Kill switch: turn the flag off; purge via `trend_purge_expired`; full rollback SQL documented.
9. Before production: full test suite, typecheck, lint, build, dedicated security review, and the migration numbering reconciled with the Admin Panel release.
