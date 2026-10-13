# Voom Trend Intelligence — Stage 2E: staging release preparation

Status: **preparation only.**

- No database has been changed: not staging, not production.
- Nothing has been committed, pushed or deployed.
- Everything below must be explicitly approved before step 1 of §2.

## 1. Candidate migration and compatibility review

### The candidate

| File | SHA-256 |
| --- | --- |
| `supabase/proposed/0055_trend_intelligence.sql` (78757 bytes, one transaction) | `93195e8ccb486bb111d7db02f27d65fbb55b7dc1a8e9b810bc463623d82a9753` |
| `supabase/proposed/0055_trend_intelligence.rollback.sql` (one transaction) | `9199325a199dee63e8d829d1e651462bc2b0eb0150e10892667c29f3d0cd2fcf` |

**How it is built**

- It is **generated**, not hand-edited: Part 1 is the storage component and Part 2 is the governance component, wrapped in one `begin … commit`.
- A test fails if the file differs from the components, or if this document quotes a stale hash.
- It stays in `supabase/proposed/`. It is not in `supabase/migrations/` until integration is approved.

**Number**

0055, after the Admin Panel's 0052–0054, as decided.

### Defects found and fixed while preparing the candidate

1. **Re-applying failed.** The source-registry seed used `INSERT … ON CONFLICT`. PostgreSQL checks NOT NULL on the proposed row before resolving the conflict, so a second run broke on the NOT NULL freshness columns that Part 2 adds. The seed is now an explicit update-then-insert-missing statement. Re-applying, including with data present, is tested.
2. **Two store calls in one transaction failed.** `SET CONSTRAINTS … IMMEDIATE` lasts for the rest of a transaction, so a second store call in the same transaction ran the completeness check before inserting its evidence. PostgREST runs one call per transaction, which is why earlier tests missed this; psql sessions and the staging test script do not. The RPC now restores DEFERRED before and after its own immediate check. A regression test covers it.

### Compatibility with staging (0001–0054)

**Hash checks**

- All 51 files 0001–0051 in this worktree match the staging bootstrap `MANIFEST.txt`, by SHA-256.
- The Admin Panel's 0052–0054 files are byte-identical to what staging ran (`603b1803…`, `552d3385…`, `25e45e8c…`).

**Staging replica (local)**

The exact staging bootstrap file (`voom-staging-bootstrap-0001-0054.sql`, SHA-256 `a0d1e119…ced`) was replayed into local PGlite with Supabase's default privileges, then:

| Check on the replica | Result |
| --- | --- |
| Candidate applies on top of 0001–0054 | ✓ |
| Re-apply (idempotent) | ✓ |
| Every existing table, column, policy, function, trigger and default privilege (non-trend) unchanged | ✓ identical |
| Rollback, then schema compared with pre-apply | ✓ identical |
| Re-apply after rollback | ✓ |
| `01-preflight.sql` / `03-verify.sql` | all rows ok |
| `04-synthetic-tests.sql` | ALL PASSED, nothing left behind |
| `05-seed-decisions.sql` → `06-cleanup.sql` → `03-verify.sql` | all counts 0, all rows ok |

**Independence from the Admin Panel**

- The candidate references only `trend_*` objects. A test checks that every `public.` name in it starts with `trend_`.
- It uses no `admin_*` object, and 0052–0054 use no `trend_*` object.
- It does not alter default privileges, roles, extensions or schedules.
- Applying in either order (0051 → 0055 → 0052–0054, or 0051 → 0052–0054 → 0055) succeeds.

## 2. Exact staging deployment procedure (owner-run; not yet approved)

The target is **voom-staging, project `qcdpegwjofrqnfudyrqq` only**. Staging was built through the SQL editor, not the Supabase CLI, so the same method is used here. No CLI, no `db push`, and no production connection string is involved.

1. **Approve.** Give explicit approval for this staging step.
2. **Verify the file.** Locally: `shasum -a 256 supabase/proposed/0055_trend_intelligence.sql` must print `93195e8c…9753`.
3. **Confirm the project.** In the dashboard, the project ref in the URL and in Settings must be `qcdpegwjofrqnfudyrqq`. If it isn't, STOP.
4. **Preflight (read-only).** In the SQL editor, run `docs/trend-intelligence/staging/01-preflight.sql`. Every row must be `ok = true`. Record the INFO rows (server version, table count, whether CLI history exists). If any row is false, STOP.
5. **Recovery point.** This staging project has no customer data and no trend objects. The recovery path is the rollback file in step 9; no paid backup is needed. Optionally, take a schema-only dump yourself with `pg_dump --schema-only` and the staging connection string, without sharing the password.
6. **Apply.** In the SQL editor, paste the **whole** candidate file and run it. It is one transaction, so it either completes or changes nothing. Expected: success with no result rows.
7. **Verify (read-only).** Run `03-verify.sql`. Every row must be `ok = true`. If any row is false, go to step 9.
8. **Tests.** Follow §3.
9. **Recovery if anything fails.**
   - **During step 6:** nothing was applied. Copy the error message and stop.
   - **After step 6:** run `0055_trend_intelligence.rollback.sql`. It removes every trend object and nothing else, and ends with a self-check (`trend_rollback_incomplete` if anything remains). Then re-run `01-preflight.sql`: the trend row must show `0/0` again.
10. **Leave it or remove it.** After testing, the trend schema can stay on staging (empty, since `06-cleanup.sql` removes synthetic data) or be rolled back with step 9. Record the outcome in a staging results document, with no keys and no codes.

**Exactly what step 6 changes on staging**

- **Creates 10 tables:** `trend_sources`, `trend_metric_definitions`, `trend_source_authorizations`, `trend_source_coverage`, `trend_observations`, `trend_observation_metrics`, `trend_evidence`, `trend_observation_invalidations`, `trend_audit_events`, `trend_purge_runs`.
  - Their indexes and constraints come with them, plus one identity sequence (`trend_audit_events_seq_seq`).
  - RLS is on, with zero policies.
- **Creates functions:**
  - 5 RPCs: store, list, invalidate (owner-only), purge run, retention status.
  - 1 internal purge function.
  - 9 trigger functions.
  - 4 settings functions.
  - About 17 triggers on the trend tables.
- **Seeds reference rows:** 4 rows in `trend_sources` and 7 in `trend_metric_definitions`.
- **Grants:** `service_role` gets SELECT on the 10 tables and EXECUTE on 4 RPCs. Everything is revoked from `public`, `anon` and `authenticated`.
- **Changes nothing else:**
  - no existing table, policy, function, grant or default privilege;
  - no extension, no `pg_cron`/`pg_net`, no schedule, no webhook, no Vault secret;
  - no data in any existing table;
  - no CLI migration-history row (consistent with how staging was bootstrapped).

## 3. Staging test checklist (synthetic data only)

| # | Step | How | Expected |
| --- | --- | --- | --- |
| 1 | Preflight | `01-preflight.sql` | all ok |
| 2 | Apply | candidate (§2 step 6) | success |
| 3 | Verify roles, grants, RLS, settings, no schedule | `03-verify.sql` | all ok |
| 4 | Database-side guarantees | `04-synthetic-tests.sql` (runs in one transaction ending in **ROLLBACK**; nothing persists) | final row `ALL TREND STAGING SYNTHETIC CHECKS PASSED` |
| 5 | Seed committed synthetic decisions | `05-seed-decisions.sql` | 1 approval, labelled STAGING-TEST |
| 6 | Real API role checks (anon key, test-user JWT, service key) | `05-postgrest-and-concurrency.md` §A–B | browser roles denied; no direct table writes |
| 7 | Real concurrency: 20 parallel identical requests | §C | 1 `stored`, 19 `duplicate`, 1 row |
| 8 | Read RPC through the API, exact precision | §D | `"18446744073709551615"` |
| 9 | Revocation through the API | §E | empty result, no permitted sources |
| 10 | Optional: revocation waits for an in-flight write | §F (two `psql` sessions) | update blocks until commit |
| 11 | Cleanup | `06-cleanup.sql` (refuses if any non-synthetic trend data exists) | all counts 0 |
| 12 | Re-verify | `03-verify.sql` | all ok |
| 13 | Optional rollback drill | rollback file, then `01-preflight.sql` | trend `0/0`, then re-apply if keeping |

**What step 4 covers inside staging's real Postgres**

- Browser roles denied.
- `service_role` cannot write tables or invalidate.
- Deny-by-default.
- Audit of decisions.
- Atomic store, duplicate and conflict handling, and the payload allowlist.
- Exact 20-digit precision; unavailable metrics stay null.
- Share locks taken.
- The database-computed retention deadline.
- Country isolation; missing coverage and coverage older than 180 days.
- Revocation, approval older than 365 days, re-approval, and the "needs new timestamp" rule.
- Owner-only invalidation, replacement as revision 2, no resurrection, history kept, audit without content.
- Bounded keyset pagination.
- Overdue detection, the bounded purge cascade, breach clearing, purge-only deletion, and run records.

**Not on staging**

Purge-failure injection (it needs a temporary trigger) stays a local test only.

## 4. Security and rollback assessment

**Access**

- Browser roles have no table, function or sequence privilege.
- `service_role` reads tables and calls 4 RPCs, and nothing else.
- Every write goes through a validating `SECURITY DEFINER` function with `search_path = pg_catalog, pg_temp` and no dynamic SQL.
- Corrections are executable by no API role; staff authorization is still a blocker.
- No secrets, keys, URLs or provider content are stored. Audit rows carry no provider content.

**Data safety**

- The migration is one transaction. Existing objects are verified unchanged on a replica of staging.
- Rollback is one transaction, removes only trend objects, verifies itself, and restores the exact pre-apply schema (verified on the replica).
- Rollback **destroys trend data and audit history**. On staging this is synthetic only.
- `06-cleanup.sql` cannot delete non-synthetic data; it refuses.

**Residual risks**

- **The database owner can disable triggers.** Owner actions are trusted and audited only while triggers are on.
- **PostgREST role behavior and real concurrency** are verified only by checklist steps 6–10, which run on staging itself.
- **Supabase-specific privileges.** The tests reproduce Supabase's default privileges and `service_role`'s BYPASSRLS. Preflight confirms that `postgres` can assume the API roles that step 4 relies on.

## 5. Production migration-order risks

Production was last reported at **0051**. Do not assume it matches staging.

| Risk | Detail | Mitigation |
| --- | --- | --- |
| Out-of-order history | If 0055 reaches production while 0052–0054 are unapplied, a later `supabase db push` of 0052–0054 is refused unless `--include-all` is used. | Production order **must** be 0052 → 0053 → 0054 → 0055. Deploy the Admin Panel migrations first, or hold Trend until they are on `main` and applied. The schema works in either order (tested); this is a history problem only. |
| Unknown production state | Production's real migration history and schema may differ from the report. | Before any production step, run a read-only check on production listing `supabase_migrations.schema_migrations` (if used) and confirming no `trend_*`/`admin_*` objects exist unexpectedly. Run `01-preflight.sql`, adjusting the admin row for production. |
| Staging ≠ production history | Staging has 0052–0054 via a hand-applied bootstrap, with no CLI history. | Never use staging's state to infer production's. Never point CLI commands at staging expecting history. |
| Pin tests | The nine "newest migration" tests on `main` must name 0055 when it is integrated, and the Admin Panel branch edits the same tests for 0054. | Integrate in order: Admin Panel first, then Trend rebases its pin-test edits onto 0054 → 0055. |
| Number reuse | Any new migration landing on `main` before integration would take 0055. | Re-check `origin/main` immediately before integration and renumber the candidate if needed (it is generated, so renaming is trivial). Production order is still Admin first. |

## 6. Confirmed still disabled (task G)

- **Provider ingestion:** no adapter, fetch, provider URL or API key exists in `lib/trends`. `createTrendAdminRpcClient()` has no caller.
- **MARA integration:** no file outside `lib/trends` imports it, and an existing test enforces that. MARA files are unchanged; `git status` shows only trend files.
- **Automatic schedules:** no `pg_cron`/`pg_net` in the candidate (a test checks). No trend entry in `vercel.json`, `supabase/ops/` or `.env.example`. The purge is callable but never scheduled.
- **Corrections:** disabled in both the database and the server code.

## 7. Remaining blockers before staging deployment

1. **Your explicit approval** of this procedure and of the candidate hash above.
2. **Staging access by you.** You run the SQL editor steps and hold the keys for checklist step 6 onward; keys are never shared in chat.

Nothing technical is known to block the **staging** test.

**Before production, separately:**

- Admin Panel migrations deployed first (or an explicit ordering decision).
- Approved purge schedule and breach alerting.
- Staff authorization for corrections.
- YouTube policy answer.
- Confirmed retention periods.
- Production history check.
