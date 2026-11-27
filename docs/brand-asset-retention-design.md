# Brand asset retention — production-readiness design gate

27 November 2026. Branch `codex/brand-kit-reliability-1f619f2` at reviewed candidate
`37ff1bf42874beca243a4a5db0c7968c108003d9` before this documentation-only commit.
Production source baseline remains `1f619f2e79773570169f8d5a3e7390a8835c9d00`.

**Outcome: implementation stopped at the user's architectural-scope gate.** No cleanup job,
runtime code, database migration, deployment or storage deletion was introduced. The eight
requirements cannot be met by re-enabling the existing sweep or adding an age filter. They
require coordinated upload, editor, database, email-copy and deletion lifecycle changes.
The previous independent staging/concurrency results were supplied by the user; this task did
not rerun hosted scenarios or inspect hosted/customer resources.

## Current contracts and evidence

| Boundary | Actual contract | Missing safety primitive |
|---|---|---|
| `app/api/brand/assets/route.ts` POST / `putBrandAssetObject` | Uploads a random owner-scoped immutable path with `upsert:false`, then returns an image reference. No SQL upload intent is recorded. | Durable inventory and ownership of uploads before/after interrupted Storage requests. |
| `BrandAssetsEditor.tsx`, `BrandHub.tsx`, `lib/voom/store.tsx` | Editors keep unsaved references in browser state. Cancel/remove sends best-effort DELETE. | No durable active operation, renewable asset lease, cancellation acknowledgement or stale-operation rejection at save. |
| `lib/brand/versions.ts` / migration 0075 | Append merges JSON assets into a new kit version. Authenticated owners can directly INSERT their own rows under RLS; the version uniqueness constraint handles collisions. | No database guard coordinating references with deletion claims. An application-only mutex/RPC would leave direct INSERT outside the fence. |
| `lib/brand/asset-storage.ts` | Physical deletion is deferred. Saved-version verification and failed-versus-empty distinction exist; there is no cleanup registry/queue. | No durable tombstone preventing a new reference while Storage.delete is outside the SQL transaction. |
| `lib/brand/email-sync.ts` | Downloads a logo, copies it into public email storage, then sets the email-brand asset ID. | No durable source Brand Kit asset ID connecting the copy to the original, or copy-operation lease. |
| `lib/email/branded/assets.ts`, `storage.ts`; migrations 0041/0042 | Separate public `voom-email-assets` paths and owner-scoped asset IDs; registration follows upload, with best-effort rollback on failure. | No cross-bucket retention/deletion manifest or authoritative lineage for historical copies. |
| `app/data-deletion/page.tsx` / Settings | Full-account deletion is documented as a manually verified team process. Platform-specific deletion is not full-account deletion. | No repository-defined automated full-account storage manifest, account write fence or durable Brand Kit deletion completion receipt. This does not prove the manual operator process is absent outside the repository. |
| Migrations 0075 and 0041 | Brand Kit and email asset metadata cascade when the auth user is deleted. | A deletion job cannot depend on those cascading rows to remember object paths after account removal. |

A database row cascade is not proof that stored bytes or public email copies were erased.
No hosted object inventory, real orphan count, manual runbook or retention SLA was verified here.

## Important retention distinction

An image removed from the latest kit may still belong to a saved historical version. Requirement
1 explicitly preserves it. Ordinary orphan cleanup therefore **must not delete images referenced
by any saved version**, even if they have not appeared in the current kit for years. Only genuinely
abandoned/unreferenced uploads are eligible. Historical-image retention ends only through an
explicitly authorized data/history deletion process; a grace period cannot override saved references.

An abandoned wizard and a sleeping browser holding a usable image reference are indistinguishable
on the current server. Time alone cannot distinguish them. A bounded active-operation lease plus
server-enforced refusal of expired/revoked references is a required change to that contract.

## Scope of the next implementation

This is one coordinated lifecycle change, not a replacement sweep: it affects the upload
route/storage boundary, wizard and Brand Hub editor, canonical append plus database direct-write
guards, email-copy registration, a deletion worker and the verified manual deletion workflow.
The initial release can keep ordinary GC limited to the private Brand Kit bucket; email objects
must still be tracked/protected and included in an explicit deletion manifest. It must not start
sweeping public email assets merely because their current logo setting changed.

## Smallest complete design to implement next

Names below are proposals, not implemented tables or callable APIs.

### 1. Durable inventory, references, operations and deletion jobs

- An owner-scoped asset registry keyed uniquely by immutable `(bucket, path)`, with upload
  operation ID, state, creation/upload-confirmation timestamps and a permanent deletion marker.
  Never reuse a claimed/deleted path or reset it to live. Store bytes only in Storage.
- Durable editor/upload/copy operation leases linked to registry assets. A lease records its
  owning operation and expiry, with authenticated renewal. The server rejects saving a path
  from an expired operation if it has already been retired. A resumed old editor must reacquire
  a live lease or re-upload; it cannot resurrect a tombstoned object.
- Reference records for every historical `brand_kits` version and email-brand configuration,
  including explicit source/destination lineage for new email copies. Retain unknown legacy
  lineage conservatively. Missing references are authoritative only after complete validated
  backfill; a partially scanned inventory is not an empty reference set.
- A durable bounded deletion queue/outbox with claim ID, mode (`orphan` versus explicit data
  deletion), attempts, retry time, outcome and minimal audit events. Its manifest must survive
  auth-user/brand/email cascades; do not attach it to an `ON DELETE CASCADE` owner relationship.
  Limit access to trusted server/operator roles. Do not log prompts, image bytes, signed URLs
  or credentials. Minimize retained identifiers after verified completion.

### 2. One database-enforced reference/deletion fence

Every writer must follow the same deterministic locking order: owner gate, then affected asset
rows ordered by stable ID. Reference insertion, lease renewal, upload finalization, email-copy
registration and deletion claiming serialize on those rows. Triggers or equivalent enforced
constraints must cover authenticated direct kit INSERT and relevant service-role updates, not
only calls to `appendBrandKitVersion`.

In one SQL transaction, an ordinary cleanup claim must establish all of:

1. Owner is not under an incompatible account-deletion operation.
2. Upload is confirmed complete, inventory is verified and the chosen grace period has elapsed.
3. No reference exists in **any** saved kit version or email-brand configuration.
4. No live upload/editor/email-copy lease exists.
5. The asset is atomically changed from live to deleting and a deletion intent is durably written.

A simultaneous save either commits its reference first (cleanup cannot claim it), or observes the
retired asset and fails without changing the kit. A new reference is never allowed between claim
and Storage removal. Locking only inside the cleanup worker does not provide this guarantee.
Failed queries, malformed legacy paths or unknown inventory state abort/skip the claim and emit
an explicit diagnostic; `[]` is accepted only from a successfully completed authoritative query.

### 3. Uploads and bounded abandonment

Proposed initial policy for review: confirmed, unreferenced uploads receive a 24-hour grace period;
active editors renew a 15-minute lease every 5 minutes. These are design defaults, not configured
production values. Grace expiry identifies candidates; the locked reference/lease fence authorizes
retirement. Saved historical references never expire under this policy. An expired editor can
continue its textual work but must revalidate/re-upload an asset before saving it.

Create upload intent before sending bytes, use an immutable no-upsert key, and positively finalize
only after the Storage response confirms completion. An ambiguous/failed response is not proof of
absence or a settled upload. Reconcile those intents and quarantine uncertain legacy/in-flight
requests. A late Storage write must not recreate a reusable asset after tombstoning. Before claiming
bounded completion, verify the Storage request-settlement/cancellation contract and fence or drain
old upload invocations. A lease timeout by itself cannot prove an external upload has stopped.

This unresolved Storage settlement behavior is a concrete implementation prerequisite, not an
assumption that the proposed schema alone solves the distributed upload/delete race.

### 4. Dry run, bounded worker and retries

- Start disabled. Dry run uses the same eligibility predicate but changes no asset state,
  performs no Storage removal and returns owner-scoped counts/reasons. Optional run audit
  metadata is separate from claiming/deleting assets. A dry-run list is not a later authorization
  to delete: execute must re-evaluate and atomically claim each item.
- Proposed cap: 25 objects and 250 MiB per run, whichever is reached first; one immutable path
  per intent and bounded execution time. Validate recorded size; unknown inventory is quarantined.
- Storage removal happens **after** the committed deleting marker, outside the SQL transaction.
  The permanent marker prevents all new references while deletion is retried. Do not hold a SQL
  transaction or advisory lock across a network request.
- Success/confirmed not-found is idempotent; transient/ambiguous failures remain deleting with
  bounded exponential backoff. Exhausted attempts require operator action and remain visible;
  they must not be marked deleted or returned to live. Use claim tokens for SQL acknowledgements.
  A crash after successful removal but before acknowledgement retries the same immutable object.
- Keep an audit of policy version, decision reason, attempt/result and deletion-request ID.
  Tombstones and inventory reconciliation detect late object reappearance. They do not justify
  reporting erasure complete while an old upload can still write that key.

### 5. Explicit account/data deletion is separate from ordinary orphan cleanup

The manual verification process must explicitly authorize the scope. Freeze the owner's relevant
asset writers, record private originals and public email copies in a durable manifest **before**
metadata cascades, and drain/fence in-flight uploads/copies. Historical kit/email references pin
ordinary GC, but do not indefinitely override an authorized deletion request for those same data.

Execute the manifest through the durable deletion worker with retries and an auditable status.
Do not report completion while owned objects or unsettled writers remain. Keep storage failures
pending/escalated, not silently retained. Erasure of specific still-referenced images also requires
an explicit decision to remove/redact their references across history and email branding; ordinary
DELETE of an unsaved editor image is not authorization for that. Previously delivered recipient
copies are outside the owned-storage deletion boundary and must not be promised erased.

A manual operator entry point may be sufficient initially; building a new account-deletion UI is
not required. Its authorization, integration with the existing manual process and completion
responsibility must nevertheless be concrete before claiming requirement 5 is implemented.

## Schema and compatibility work required

A new migration is necessary for registry, references/lineage, leases, account fencing and durable
jobs/audit, plus guards on existing writers. No migration SQL was prepared: the user explicitly
requires stopping when safe implementation becomes an architectural change. Shipping partial DDL
without the complete writer/deletion contract would falsely imply readiness. Reserve the next
migration number only after checking the release ledger and parallel branches; do not reuse 0079
or alter MARA Memory. Nothing was applied to any database.

Suggested rollout: additive schema with cleanup disabled; deploy registration/leases in all writers;
drain older server invocations and handle older browser operations; backfill all saved versions,
email references and paginated object inventory; quarantine uncertainty; enable database guards;
run and review dry runs; then separately authorize bounded deletion. Old writers must not coexist
with an enabled collector. Rollback first disables/drains deletion workers and restores a compatible
app; never remove deletion tombstones/guards while requests can still mutate references.

## Required implementation and contention tests

| Scenario | Required outcome |
|---|---|
| Historical version or email configuration references an image | No orphan deletion claim; newest-kit removal alone is irrelevant. |
| Reference query fails or inventory/backfill is partial | Unavailable/quarantined, no deletion. Successful verified empty reads remain distinct. |
| Save wins lock before cleanup | Reference persists; cleanup refuses claim. |
| Cleanup wins lock before save | Save rejects retired path without partial kit persistence; re-upload/retry required. |
| Live editor, new upload or email copy races with cleanup | Lease/intent prevents retirement; copying and destination registration retain lineage. |
| Sleeping browser resumes after lease expiry/deletion claim | Reference reacquisition fails safely; no resurrection or broken saved references. |
| Upload response ambiguous or worker crashes | Durable intent survives; no premature orphan/erasure-complete decision. |
| Confirmed abandoned upload exceeds grace | Eligible only after locked absence of references/leases; bounded removal. |
| Storage removal fails, times out, or succeeds before worker crash | Same immutable intent retries; no false success, path reuse or duplicate effects. |
| Two workers claim concurrently | Disjoint claims or idempotent same-object recovery; claim-token acknowledgement. |
| Account deletion races with save/upload and auth-row cascade | Writes fenced; manifest survives; public/private objects accounted for before completion. |
| Dry run and partial batch failure | Dry run removes nothing; batch caps enforced; each result independently auditable. |
| Foreign-owner path, forged lease, direct authenticated INSERT | Rejected at database/API boundary; no cross-owner enumeration/deletion. |

Use real simultaneous PostgreSQL sessions and a controllable Storage double that can complete an
upload after a delete attempt. Embedded SQL interleavings alone cannot validate the external race.
Do not use hosted customer assets or claim these future protocol tests were performed in this task.

## Local validation of the unchanged safety candidate

| Check | Result |
|---|---|
| Existing Brand Kit reliability + asset safety tests | **37 pass / 0 fail** |
| Full `npm test` | **2699 total: 2625 pass / 32 fail / 42 skipped** |
| Fresh unchanged Production failed-file comparison | **149 total: 118 pass / 31 fail**; 31 of the full-run failures reproduced |
| Remaining full-run failure | Browser cleanup's abandoned-run timing case; also failed on the unchanged baseline in the preceding correction task; isolated rerun recorded below |
| `npm run typecheck` | **PASS** |
| `npm run lint` | **PASS**, 0 errors / 16 existing warnings |
| `git diff --check` | **PASS** |

Baseline comparison reran the 14 failed files at a clean `1f619f2` export, not a second full
baseline suite. The fresh run reproduced 31 of 32 failure names; the remaining abandoned-run
browser cleanup case is environment/timing dependent and also appears in the prior unchanged
baseline evidence from the independent-review corrections task. All 32 names are covered by
those baseline runs. Runtime, tests and dependencies have no changes in this task. No new
regression is inferred from this documentation-only diff; the full suite is still not green.

The isolated abandoned-run retry also failed: cleanup expected zero remaining test artifacts
and found two. Its test and helper have no diff against Production source. This was local
browser-helper process cleanup, not a Brand Kit storage deletion test. It remains an unresolved
environment-dependent validation failure; no unrelated test/helper fix was attempted.

Other failures are the inherited source/config, trend/date and performance cases recorded in
`brand-kit-reliability-review-corrections.md`. Skips include unavailable browser support and
existing intentional/history-dependent skips. No live browser, hosted database or real concurrent
Storage tests were run here. No new tests of a collector are claimed, because no collector
was implemented. The user-validated candidate remains the runtime unchanged.


Only this design, the decision log and handover change. No new runtime mechanism or regression
tests are claimed. The existing tests verify the retained safe behavior, not the proposed collector.
