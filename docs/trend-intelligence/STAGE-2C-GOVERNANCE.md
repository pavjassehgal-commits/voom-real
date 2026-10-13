# Voom Trend Intelligence — Stage 2C: Supabase RPC and data governance

Status: **local only.**

- New SQL lives in `supabase/proposed/trend_intelligence_governance.sql` and applies after `trend_intelligence_storage.sql`. It is unnumbered, not in `supabase/migrations`, and not applied anywhere.
- No schedule, `pg_cron` job, worker, credential or provider connection exists.
- Nothing in the app calls the adapter.

## 1. RPC architecture

| Function (service_role only) | Purpose |
| --- | --- |
| `trend_store_observation(p_observation jsonb, p_replaces uuid)` | The only write path. Stores one observation with its metrics and evidence atomically. |
| `trend_invalidate_observation(id, reason, actor, reference)` | Records an append-only invalidation. |
| `trend_run_retention_purge(p_limit)` | One bounded retention pass. Every run is recorded. |
| `trend_retention_status()` | Retention health for monitoring. |

**Function properties:**

- All four are `SECURITY DEFINER` with `search_path = pg_catalog, pg_temp`. Every object is schema-qualified.
- None of them uses dynamic SQL, which a test checks.
- `EXECUTE` is revoked from `public`, `anon` and `authenticated`, and granted to `service_role` only.
- Internal trigger and purge functions are executable by no API role.
- `service_role` no longer has INSERT on any trend table. It has SELECT only, which the read model uses.

**What the store RPC does, in order:**

1. **Checks the payload shape.** It must be a JSON object under 64 KB containing exactly the allowed keys. Any extra key, such as `delete_after`, `expires_at`, `trend_key` or `revision`, is rejected as `invalid_payload`. Metric values must be decimal strings so precision is exact: up to 40 integer and 20 fractional digits, stored as `numeric`. Metrics must be exactly the source's declared keys. There can be 1–20 evidence entries, each with only the allowed keys.
2. **Checks current approval and coverage with `FOR SHARE` locks.** Approval must be `approved`, have a reference, not be in the future, and be no older than 365 days. Coverage must be `verified`, not in the future, and no older than 180 days. The locks make a concurrent revocation wait until this insert commits; a test asserts the RowShare locks are taken. The Stage 2A database triggers re-check approval and coverage as a backstop.
3. **Computes freshness and the deletion deadline from `trend_sources`.** The caller cannot choose them. The deadline is the earlier of expiry and retrieval plus the source cap (YouTube ≤ 30 days). Expired input is refused.
4. **Inserts the observation with `on conflict … do nothing`.** A duplicate identity is compared with the latest stored revision and reported as `duplicate`, `conflict` or `invalidated`. Nothing is overwritten.
5. **Inserts metrics and evidence, then runs the completeness check immediately.** Everything happens inside one exception block, so any failure rolls back all three tables and returns a sanitized code. Raw errors never leave the function.

**Application side:**

- `lib/trends/supabase-rpc.ts` is the only module that touches `createAdminClient()`, following the `consume_rate_limit` pattern. It is not called anywhere.
- `storage.ts` re-validates the observation, refuses expired data, and refuses any value that is already imprecise in JavaScript (integers above 2^53). Values are sent as exact decimal strings.

## 2. Evidence correction

- **Invalidation record.** `trend_observation_invalidations` holds the observation, a reason code from a fixed list, the time, an actor and a reference. It is append-only: updates are blocked and deletes happen only through the purge. It cascades with its observation, so it never outlives the source's retention.
  - The actor must be an opaque id, e.g. `admin:<uuid>`. Emails and names are refused.
  - The reference must be a ticket id. Spaces and slashes are refused, so it cannot carry titles or URLs.
- **What invalidation does.** The observation disappears from the read model, and therefore from recommendations. Its evidence and metrics stay exactly as recorded.
- **Replacement.** A correction is stored with `replaces` as revision *n + 1* of the **same identity and window**. A trigger allows revision *n + 1* only directly after an invalidated revision *n*, even for the owner. So there is at most one live revision, and a replay of the original cannot bring revision 1 back.
- **No bypass.** Replacements go through the same RPC, so approval, coverage, metric, evidence and retention rules all apply. If the source has since been revoked, the correction is refused and the wrong data stays hidden.
- **Helpers:**
  - `governance.ts › correctTrendObservation` invalidates, then stores the replacement. It is deliberately two steps: if the replacement fails, the hidden state is safe and the replacement can be retried.
  - The server caller must authorize the human actor, for example as an MFA administrator, before calling.

## 3. Source permission history

- **The audit table.** `trend_audit_events` is append-only. Each event records the event type, an ordering `seq`, the time, the database role, the actor, the source, platform and country, the previous and next state (fixed fields only), and the reference.
- **How it is written.** Only `AFTER INSERT/UPDATE/DELETE` triggers on the authorization and coverage tables write it, so every change is recorded, including the owner's edits in the SQL editor. The invalidation RPC also writes it.
- **Decision rule.** A changed decision must carry a new decision timestamp (`trend_decision_needs_new_timestamp`). Coverage now records `checked_by`, and every decision, including a revocation, needs a reference.
- **Immutability.** Updates are blocked. Deletes happen only through the retention purge. `service_role` has SELECT only, and other roles have nothing, including on the identity sequence.
- **Retention: 730 days.** Audit rows hold no provider content: no subject, item id, URL, attribution or metric value. The invalidation copy holds only ids, codes and the ticket reference. Two years covers an annual review cycle plus a following compliance audit without keeping governance records indefinitely. This is a **provisional default** for the owner or legal to confirm.

## 4. Retention and purge

- **`trend_run_retention_purge(p_limit 1–1000)`.** It takes no time argument and uses the database clock only, so nothing can be deleted early. In one pass it:
  1. deletes overdue observations, oldest deadline first, with `skip locked`; metrics, evidence and invalidations cascade;
  2. deletes audit events older than 730 days;
  3. deletes purge-run records older than 90 days.
- **Deletes only through the purge.** Observation, invalidation, audit and run-record deletions are allowed only inside the purge functions, through a transaction-local flag. A direct delete fails even for the owner. API roles have no DELETE privilege at all, so the flag gives them nothing.
- **Failure detection.** Every run, successful or failed, is recorded in `trend_purge_runs` with counts, the number of rows still overdue, the oldest overdue deadline and a sanitized error code. A failed run rolls back completely: no partial deletion.
- **`trend_retention_status()`** reports:
  - `overdue` and `oldest_overdue_at`;
  - `breach`, meaning any row more than 24 hours past its deadline or any YouTube row older than 30 days;
  - `youtube_policy_breach`;
  - the last success and the last failure, with its code.
- **Expired rows are never served.** The read model excludes rows past `expires_at` or `delete_after`, and invalidated rows.
- **Activation is not done.** Nothing calls the purge. Before any real ingestion, the owner must approve how it runs, for example a database-only `pg_cron` job every hour with a small limit, and how a `breach` alert reaches a person.

## 5. Guarantees and limits

**Guaranteed in the tested schema:**

- browser roles cannot read, write or execute anything;
- `service_role` writes only through validated RPCs;
- identity, deadlines and freshness are computed by the database;
- there are no partial writes;
- duplicates and conflicts never overwrite;
- history is append-only with recorded actors;
- deletion is bounded and recorded;
- large values are stored exactly or refused.

**Limits:**

- **Concurrency is only partly tested.** PGlite runs one session, so concurrent RPCs are serialized. The guarantees rely on PostgreSQL's unique index and row locks, which are standard, but they have not been exercised against a real multi-connection Postgres.
- **Owner trust.** The database owner (superuser) can still disable triggers. Owner actions are audited only while triggers are enabled.
- **Actor identity is asserted by the server.** The database validates only the actor's format.
- **Normalization isn't re-checked.** `subject_normalized` is checked for shape, but the NFKC normalization itself happens in the app.
- **Fixed review periods.** The 365-day and 180-day review periods are fixed in SQL and in `policy-store.ts`. Explicit `review_by` / `recheck_by` columns remain a proposal.
- **The read path isn't an RPC yet.** It still uses the SQL port and needs an RPC or a view before production.
- **Rollback.** The governance rollback refuses to run while corrected revisions exist, and it destroys the audit trail.
