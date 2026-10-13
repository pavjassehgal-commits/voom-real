# Voom Trend Intelligence — Stage 2B server-only storage integration

> **Superseded in part by Stage 2C** (`STAGE-2C-GOVERNANCE.md`): writes now go through the service-role RPC `trend_store_observation` via `lib/trends/supabase-rpc.ts`. The transactional SQL port remains only for the read model and policy loading. §5–§6 below are implemented in Stage 2C.

Status: **local development only.**

- Tested against the proposed SQL in PGlite.
- The migration is still unnumbered and has not been applied anywhere.
- No caller, route, worker, credential or provider connection exists.
- Live ingestion stays disabled because there is no ingestion code at all.

## 1. Modules

| File | Role |
| --- | --- |
| `lib/trends/db.ts` | The `TrendDatabase` port: `query(sql, params)` plus `transaction(fn)`. Also extracts safe `trend_*` error tokens and normalizes timestamps. |
| `lib/trends/policy-store.ts` | `loadTrendMarketPolicy(db, { now })` turns the authorization and coverage tables into a Stage 1 `MarketPolicy`. `permittedSources(policy, platform, country)` lists usable sources. |
| `lib/trends/storage.ts` | `storeTrendObservation` stores one observation; `storeTrendObservations` stores a batch (at most 200, each in its own transaction). |
| `lib/trends/read-model.ts` | `listUsableTrendObservations(db, { platform, country, language?, now, limit })` reads usable observations. `toTrendObservation(stored)` converts to the Stage 1 shape. |

All four start with `import "server-only"`. A guard test enforces that they:

- reach the database only through the injected port;
- import no Supabase client, network library, environment variable, clock, randomness, AI or MARA code;
- are never imported by the five pure Stage 1 modules.

### Why a port instead of `createAdminClient()`

Storage must write an observation, its metrics and its evidence in one transaction, because the schema seals an observation at commit. The Supabase JS client used across Voom cannot run a multi-statement transaction from application code, and the repository has no Postgres driver.

Production wiring therefore needs one of two things, and each needs owner approval first:

- **(a) A service-role RPC (recommended).** A `trend_store_observation(jsonb)` function in the proposed migration would perform the same steps inside the database. The app would then call it with `createAdminClient().rpc(...)`. This is a schema change, and it was not made in this stage.
- **(b) A server-only Postgres driver.** This means a new dependency plus a pooled service connection string, which is a credential.

The TypeScript in this stage defines the exact behavior either option must reproduce, and the tests pin that behavior.

## 2. Storage flow (`storeTrendObservation`)

1. **Re-validate.** The observation is re-parsed with `parseTrendObservation` and must match its validated form exactly. A hand-built or altered object is refused with `observation_not_validated`.
2. **Check expiry.** An observation that is already expired is refused (`observation_expired`).
3. **Set the deletion deadline.** `delete_after` is the earlier of two times: when the observation expires, and retrieval plus the source's cap (YouTube 30 days, others 365).
4. **Re-check permission inside the transaction.** The current policy is loaded. The source must be `approved` and the market's coverage `verified`. Otherwise the result is `source_not_authorized` or `coverage_not_verified`, carrying `policyIssues` that explain why. The database triggers re-check both, as a backstop.
5. **Insert the observation** with `on conflict … do nothing`.
   - The database-generated keys must equal `storageKeys()`; if they don't, the transaction aborts (`identity_mismatch`).
   - If nothing was inserted, the stored row is compared with the incoming one. An identical row returns **`duplicate`**. A different row returns **`conflict`**, and the stored row is left untouched.
6. **Insert every metric exactly as validated.** Measured values are stored as exact `numeric`, with their unit and definition version. Unavailable metrics are stored with their reason and no value. Then insert every evidence row with its attribution.
7. **Commit.** The deferred database check requires evidence and every required metric to be present.
8. **Map errors to stable codes:** `metric_rejected`, `evidence_rejected`, `retention_rejected`, `storage_rejected`, `storage_failed`. When a database guard fired, `detail` carries only its `trend_*` token. Raw database messages are never returned.

## 3. Policy loading (deny by default)

| Situation | Result |
| --- | --- |
| No authorization row | Not usable (not reviewed) |
| `under_review` | Not usable |
| `not_approved` (refused or revoked) | Not usable, whatever its age |
| `approved` but incomplete, dated in the future, or older than **365 days** | Not usable (`invalid_record`, `decision_in_future`, `authorization_expired`) |
| Coverage missing, `unavailable` or `unverified` | Not usable |
| `verified` but incomplete, in the future, or older than **180 days** | Not usable (`coverage_expired`, …) |
| Unknown source, or a platform the source doesn't support | Ignored, with an issue recorded |
| Any read error, or more rows than the bounds (100 authorizations, 5,000 coverage rows) | `complete: false`; the policy permits nothing |

The 365-day and 180-day review periods are **provisional product defaults**, because the schema has no expiry column (see §6). A caller can shorten them but never lengthen them.

## 4. Read model

The read model runs in a read-only transaction and returns at most 200 rows, newest window first. An observation is returned only when all of these hold:

- its source is in `permittedSources` under the current policy, so revoking a source immediately hides its stored data, and re-approving shows it again;
- `expires_at > now`;
- `delete_after > now`, so rows waiting to be purged are never served;
- `retrieved_at <= now`.

Each returned metric carries its unit and definition version. Measured metrics also carry `exactValue`, the exact stored number as a string. Unavailable metrics stay `{status: "unavailable", reason}`, which is distinct from a measured `0`. Evidence is returned exactly as stored, attribution included.

## 5. Proposal: evidence invalidation and replacement (not implemented)

**Problem.** An observation with wrong evidence can't be fixed today:

- rows are immutable;
- `service_role` cannot delete;
- the uniqueness rule on (source, trend, window) blocks storing a corrected version.

The only option today is for the owner to hard-delete the observation and let the cascade remove its metrics and evidence. That destroys the audit trail, so a schema change is necessary.

**Proposed design (one additive migration, needs approval):**

1. **`trend_observation_invalidations`**, append-only.
   - Columns: `observation_id` (PK, FK, cascade on purge), `reason_code` (from a fixed list: `wrong_evidence_url`, `wrong_item`, `wrong_market`, `wrong_metric`, `source_withdrawn`), `invalidated_at`, `invalidated_by`, `reference`.
   - No UPDATE or DELETE grants, and an immutability trigger.
   - Rows are inserted by the owner, or by a narrowly scoped `SECURITY DEFINER` function that requires a reason and a reference.
2. **`trend_observations.revision smallint not null default 1`**, added to the identity key: `(source, trend_key, window_start, window_end, revision)`.
   - The insert guard allows revision *n* > 1 only when revision *n − 1* has been invalidated, so there is at most one live revision per identity.
   - The original row stays immutable and keeps its evidence.
3. **The read model** excludes any observation that has an invalidation row.
4. **Optionally, `replaces_observation_id`** on the new revision, so the correction chain can be read directly.
5. **Purge** continues to delete by `delete_after`. Invalidation records go with their observation, so retention limits still apply to the whole chain.

This keeps immutability, because nothing is ever edited. It records who corrected what, when and why, and it lets corrected data replace bad data without a gap in history.

## 6. Proposal: authorization and coverage history (not implemented)

**Problem.** `trend_source_authorizations` and `trend_source_coverage` hold only the current state. An approval that is changed, or a coverage check that is re-run, leaves no trace.

**Proposed design (one additive migration, needs approval):**

- **`trend_policy_events`**, append-only.
  - Columns: `id`, `occurred_at default now()`, `db_role` (`current_user`), `entity` (`authorization` | `coverage`), `operation` (insert/update/delete), `source_id`, `platform`, `country`, and `before` / `after` as jsonb with fixed columns only: status, decided/checked times, decider, reference or evidence.
  - Written **only by `AFTER INSERT/UPDATE/DELETE` triggers** on the two policy tables, so no change, including one made by the owner in the SQL editor, can bypass it.
  - Immutability trigger; RLS with no policies; `service_role` gets SELECT only; no DELETE grant for any role.
  - Kept longer than observations, and never purged by `trend_purge_expired`.
- **Explicit expiry columns:** `review_by timestamptz` on authorizations and `recheck_by` on coverage. These would replace the code-level 365/180-day defaults with recorded decisions. `policy-store` would honor whichever comes first.
- **Optional:** reject a status change that comes without a new `decided_at` and `reference`, so every change carries its own justification.

## 7. Remaining limits

- **No production connection exists.** See §1.
- **Concurrency is only partly tested.** PGlite serializes transactions, so the concurrency tests prove deduplication through `on conflict do nothing` and the unique index, but not true parallel sessions. Postgres's unique index gives the same guarantee across connections. The authorization re-check in the trigger runs at statement time (read committed). A revocation committed after the insert statement but before commit is not seen; this race window is milliseconds long.
- **The first stored version wins.** A later conflicting observation for the same identity is reported, not stored. The invalidation design (§5) is how corrections would happen.
- **`toTrendObservation` converts values to JS numbers**, so counts above 2^53 lose precision there. `exactValue` keeps the exact figure.
- **The read model has no pagination cursor yet**, only a hard limit.
- **Some timing tests are relative to the real clock**, because the database guards use `now()`. They stay robust because they use wide margins.
