# Voom Trend Intelligence — Stage 2D: read RPC and staging preparation

Status: **local only.**

- Both SQL files remain unnumbered under `supabase/proposed/`. Nothing has been applied to staging or production.
- No purge schedule, worker, credential or provider connection exists.
- No app code calls the trend modules.

## 1. Read RPC

`trend_list_usable_observations(p_platform, p_country, p_language = null, p_limit = 50, p_after_window_end = null, p_after_id = null) → jsonb`

**Access and safety**

- `SECURITY DEFINER`, `STABLE`, `search_path = pg_catalog, pg_temp`. No dynamic SQL.
- EXECUTE is granted to `service_role` only. `anon` and `authenticated` are denied, which is tested.
- It uses the **database clock**, so no caller can read "as of" another time.

**Validation (in the database and again in the adapter)**

- Platform must be one of the four platforms.
- Country must be ISO alpha-2 in upper case.
- Language must be a registered tag or `und`.
- Limit must be 1–200.
- The cursor must have both parts or neither.
- Invalid input returns `{status: "invalid_query", reason}`.

**Which rows it returns**

A row is returned only when **all** of these hold now:

- its source is approved, has a reference, and the decision is no older than the authorization review period;
- its market has verified coverage no older than the coverage review period;
- it has not been invalidated;
- it has not expired;
- it is not past its deletion deadline;
- it has already been retrieved.

**Ordering and pagination**

Rows are ordered by `(window_end desc, id desc)` with keyset pagination. The function fetches `limit + 1` rows to decide `next_cursor`. A test walks every page and checks there are no gaps and no repeats.

**Response shape**

The response always has the same keys:

- Each row has 23 named keys. Metrics have 5 keys and evidence entries have 4.
- Metric values are **exact decimal strings**. Unavailable metrics carry `value: null`, `definition_version: null` and a reason.
- Evidence keeps its attribution.

**Adapter (`listUsableTrendObservationsRpc` in `lib/trends/read-model.ts`)**

- Validates the query, then rebuilds every row strictly.
- Fails closed with `unavailable / storage_failed`, never a partial result, if any of these occur:
  - a malformed field;
  - a value that isn't a decimal string;
  - an unavailable metric that has a value;
  - a non-https link;
  - a row from another market;
  - a source that isn't permitted;
  - too many rows;
  - a bad cursor;
  - a transport error.

**Stage 2B behavior is preserved**

`listUsableTrendObservations` over the SQL port is unchanged. A test proves both paths return identical observations.

## 2. Governance settings (provisional product defaults)

| Setting | Value | Where |
| --- | --- | --- |
| Source authorization review | 365 days max | `trend_authorization_review_period()` |
| Market coverage review | 180 days max | `trend_coverage_review_period()` |
| Policy and correction audit history | 730 days | `trend_audit_retention_period()` |
| Purge-run records | 90 days | `trend_purge_run_retention_period()` |

- Each value is defined **once** in SQL, as an immutable function used by the store RPC, the read RPC, the backstop insert guard and the purge.
- Each is defined once in TypeScript too, as `TREND_GOVERNANCE_SETTINGS`, which `policy-store.ts` uses.
- A test fails if they differ, or if any literal copy remains in the SQL.
- These are **product defaults, not legal conclusions**.
- Source content retention is unchanged: YouTube data is kept at most 30 days, other sources at most 365 days, and normally only until expiry.
- **No purge schedule is active.**

## 3. Correction permissions: disabled (blocker)

Only authorized Voom staff may invalidate an observation. **This codebase has no staff authority to check against:**

- no admin membership table;
- no staff role;
- no MFA admin session.

The Admin Panel's MFA admin memberships and `requireAdminSession()` exist only in the paused, unmerged Admin Panel worktree, which is out of scope.

Therefore corrections are **disabled**, as required:

1. **Database.** `trend_invalidate_observation` is executable by **no API role**, not even `service_role`. Only the database owner can run it, from a reviewed operational script.
2. **Server.** `invalidateTrendObservation` no longer accepts an actor from the request. The actor must come from a `TrendStaffAuthorizer` that derives it from the authenticated server session.
   - The only authorizer provided, `CORRECTIONS_DISABLED`, always denies. It is the default.
   - Authorizer errors also deny.
   - An actor that isn't an opaque id is refused.
3. **Tests.**
   - The disabled path is tested: the default denies, an erroring authorizer denies, and even a server that wrongly claims staff status cannot invalidate through `service_role`.
   - The correction mechanism itself is tested only as the database owner with a clearly labelled test-only authorizer.

**To enable corrections later (needs approval):**

1. Merge a staff authority, such as the Admin Panel's `admin_memberships` with MFA (AAL2).
2. Implement a server `TrendStaffAuthorizer` on it.
3. Change `trend_invalidate_observation` to verify the actor against that membership **inside the database** (active, correct role) before granting it to `service_role`.

## 4. Migration review: both files together

| Finding | Severity | Fix |
| --- | --- | --- |
| Re-running the storage file after governance would restore direct INSERT for `service_role`, the old purge grant, and guard functions without the RPC marker, breaking the RPC. | High (privilege regression) | **Fixed.** The storage file now refuses to run once governance objects exist (`trend_storage_reapply_after_governance`). The documented rollback path (governance rollback, then storage) still works and is tested. |
| The backstop insert guard checked "approved" and "verified" but not their review periods, so it was weaker than the RPC. | Medium | **Fixed.** Governance redefines it with the review periods. |
| Review and retention periods were repeated as literals across functions. | Medium (drift) | **Fixed.** They are now single settings functions, with a drift test. |
| Supabase default privileges grant new tables, functions and sequences to `anon`, `authenticated` and `service_role`. | High if missed | **Verified.** The tests reproduce the defaults first. A privilege inventory test asserts that the only grants are `service_role` SELECT on the 10 tables and EXECUTE on 4 RPCs. The audit sequence is locked. |
| Governance rollback drops the settings functions that the redefined guard uses. | Low (fails closed) | **Documented.** Until the storage file is re-applied immediately afterwards, as the rollback header requires, inserts fail rather than succeed. |
| Each file has its own `begin`/`commit`. | Integration | Combine into one migration with a single transaction (see §5). |
| PostgREST runs `STABLE` functions in read-only transactions. | Info | Correct: only the read and status RPCs are `STABLE`, and they only read. |

## 5. Integration and numbering plan (nothing numbered yet)

**Current state**

- `origin/main` = `f15b5bc`, ending at `0051_ai_request_rate_limits.sql`.
- The paused Admin Panel worktree holds **unmerged** local `0052`–`0054`. It also edits the repository's "newest migration" pin tests: `youtube-provider`, `email-automation-*`, `campaigns-v3-*`, `multi-social-core`, `post-*`, `tiktok-provider`, `mara-media-brief` and others.
- `supabase db push` refuses a migration older than the newest one already applied unless `--include-all` is passed. So **numbering order must match apply order.**

**Rules**

1. Trend Intelligence never uses `0052`–`0054`.
2. At integration, combine the two proposed files into **one** migration file, `NNNN_trend_intelligence.sql`, with a single transaction. In that file the storage re-apply guard is no longer needed and the governance file's redefinitions become the only definitions. Rollback becomes one file.
3. `NNNN` = the next free number on `origin/main` **at that moment**, chosen by one of these options:
   - **A (preferred if the Admin Panel resumes first):** the Admin Panel merges `0052`–`0054`, then Trend takes `0055`.
   - **B (if Trend ships first):** Trend takes `0052`. The Admin Panel, when resumed and with owner approval, renumbers to `0053`–`0055` before merging. Its files are still local and unapplied, so this is only renames plus its pin-test updates.
   - **Never C:** Trend `0055` applied while `0052`–`0054` are unapplied, which forces `--include-all` and out-of-order history.
4. The same change updates the nine pin tests to the new newest migration. Whichever branch lands second rebases those test edits; they cannot both be "newest".
5. Before numbering, re-check `origin/main` for any new migrations from other work.

## 6. Staging test checklist (for later; no staging changes made)

**Target:** the existing isolated `voom-staging` Supabase project (`qcdpegwjofrqnfudyrqq`) only.

**Preconditions**

- [ ] Owner approval for this staging step.
- [ ] Confirm the linked project ref is `qcdpegwjofrqnfudyrqq` before **every** command. Never use the production ref.
- [ ] Use the staging service-role key only. It is read at run time from the staging dashboard or the local environment, never committed, printed or logged. No production credentials are present in the shell.
- [ ] No customer data. Use synthetic observations only (fake video ids, `example.com` evidence). Approval and coverage rows are labelled `STAGING-TEST`.
- [ ] Take a staging backup or snapshot, or record that point-in-time recovery is available, before applying.

**Migration compatibility**

- [ ] Check Postgres version and extensions (`pg_current_xact_id`, identity columns, `jsonb`) on staging.
- [ ] Apply the combined migration once. Re-run it and confirm it is idempotent.
- [ ] Confirm the 10 tables, 4 RPCs and settings functions exist, and that the PostgREST schema cache sees the RPCs.
- [ ] Confirm existing customer tables, RLS and policies are unchanged (diff `pg_policies` and grants before and after).

**Roles and access**

- [ ] Through PostgREST with the **anon** key: every trend table and RPC is denied.
- [ ] Through PostgREST with a **test user** JWT: every trend table and RPC is denied.
- [ ] With **service_role**: SELECT only on tables. INSERT, UPDATE and DELETE are denied. The 4 RPCs work. `trend_invalidate_observation` is denied.
- [ ] RLS is enabled with zero policies on every trend table. The privilege inventory matches the local test.

**RPC availability**

- [ ] `trend_store_observation` stores a synthetic observation. An identical replay returns `duplicate`; a changed one returns `conflict`.
- [ ] `trend_list_usable_observations` returns it with exact values. Pagination works.
- [ ] Invalid queries and payloads return sanitized codes, never raw errors.

**Concurrent transactions (real multi-connection; PGlite could not test this)**

- [ ] 20 parallel identical store calls: exactly one `stored`, the rest `duplicate`, one row.
- [ ] Parallel different observations: all stored, no deadlocks.
- [ ] A revocation (UPDATE of the authorization row) issued while a store transaction holds its `FOR SHARE` lock waits, and the next store is refused.

**Source revocation**

- [ ] Revoke, then confirm new stores are refused and stored rows are hidden from the read RPC. Re-approve and confirm they are visible again.
- [ ] An approval older than 365 days, or coverage older than 180 days, is treated as not permitted (set the dates backwards on the test rows).

**Correction history**

- [ ] Confirm `service_role` cannot invalidate (disabled).
- [ ] As the owner, from a reviewed script: invalidate one synthetic row, store its replacement as revision 2, confirm the read RPC shows only revision 2 and that the audit event holds no content.
- [ ] Authorization and coverage changes appear in `trend_audit_events` with actor, before, after and reference. Edits without a new decision time are refused.

**Data retention and purge health**

- [ ] Seed one overdue synthetic row as the owner. `trend_run_retention_purge(10)` deletes it with its metrics, evidence and invalidation, and records a run.
- [ ] `trend_retention_status()` reports overdue and breach before the purge and is clear after. A forced failure (temporary blocking trigger, removed afterwards) is recorded as `failed` with nothing half-deleted.
- [ ] Confirm **no** `pg_cron` job exists for trends (`cron.job` is empty of trend entries).

**Rollback and recovery**

- [ ] Run the combined rollback on staging: all trend objects are gone, and customer schema, RLS and grants are identical to the pre-apply snapshot.
- [ ] Re-apply the migration and confirm it applies cleanly again.
- [ ] Remove all synthetic data and reset the decisions afterwards. Record results in a staging results document (no secrets, no codes).

## 7. Remaining blockers

1. **Staff authority for corrections.** Corrections stay disabled until an approved staff and MFA source exists and the database verifies the actor against it (§3).
2. **Purge execution.** No schedule is approved. Real data must not be stored until it is, and until breach alerts reach a person.
3. **YouTube policy.** Whether trend analysis of the most-popular chart is allowed under the developer policies (Stage 1.5) is unresolved.
4. **Migration numbering.** This depends on the Admin Panel's timing (§5, option A or B needs an owner decision).
5. **Real-Postgres concurrency and PostgREST role behavior.** These are proven only by the staging checklist above, not locally.
6. **Provisional periods** (365/180/730/90 days) need owner or legal confirmation.
