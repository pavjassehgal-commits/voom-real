# Native YouTube resumable uploads — 50 MiB release candidate

Branch `codex/youtube-resumable-uploads`, based on main `e322af0` (PR #98). The separate, uncommitted YouTube compliance worktree was not altered. Migration 0066 is installed on staging only; Production has not been changed by this work. The chronological implementation notes below include earlier, superseded plans. The current release is **52,428,800 bytes (50 MiB)**, not 256 MiB. No spend-cap or global Storage-limit increase is part of this release.

## Architecture and limits

- Reuses Supabase private Storage, `mara_drafts`, `post_draft_assets`, the canonical `attach_youtube_uploaded_video` approval/version operation, owner-authenticated server routes, and the existing YouTube streaming/resumable publishing worker.
- Adds an isolated **`youtube-uploads`** private bucket, MP4-only. The bucket/schema have an internal ceiling of 268,435,456 bytes, but the server, editor and hosted global limit restrict this release to **52,428,800 bytes (50 MiB)**. Larger uploads are not supported or advertised. Existing `mara-media` settings and other integrations' upload limits are not changed. Original bytes are not transcoded. Standard video metadata is limited to 12 hours; Shorts remain square/vertical and at most 180 seconds.
- Metadata-only same-origin authenticated requests create an owner/draft/version-scoped session. A signed Storage upload capability authorizes only one server-generated immutable path. Storage's documented token lifetime is **two hours**; the implementation checks expiry and never returns service credentials. There is **no upsert** and no browser list/read policy on the new bucket.
- The actual maintained `tus-js-client` uploads directly to the project's Storage hostname in **6 MiB chunks**. It persists resumable URLs, queries acknowledged offsets, bounds retries, supports pause/cancel/reselection after reload, and never posts video bytes to Vercel. A full-file SHA-256 fingerprint is computed incrementally in 1 MiB slices with lazy-loaded `@noble/hashes`, preventing accidental continuation with a changed file while keeping browser memory bounded. These libraries load only when needed.
- Sessions accept renewed owner-authenticated grants only within a 24-hour window. Three unfinished sessions per owner and ten allocations per rolling 24 hours bound staging/orphan pressure; one active session per draft, idempotent request keys and validation leases avoid duplicate logical operations. Uploads do not deduct AI credits.
- Before attachment, the server independently verifies stored size/MIME, reads bounded exact HTTP ranges, walks ISO-BMFF box headers including 64-bit sizes, skips the media payload and reads up to 8 MiB of `moov` metadata. It reuses the existing video track/dimensions/duration parser. This is structural validation, **not frame-by-frame decoding, malware scanning or transcoding**; H.264 MP4 is recommended for consistent browser playback. Extremely large metadata boxes are rejected rather than buffered without a bound.
- The final transactional operation locks draft → publishing queue → session, checks the original owner/content version, rejects provider-owned jobs or active/uncertain AI generation, attaches only the verified registered object and revokes obsolete approval/synthetic-media declarations. Copy, hashtags/script, proposed time, privacy and audience choices remain intact. It cancels only this draft's unclaimed queued work; upload never automatically approves/queues/publishes content.
- Private previews reuse owner-only 15-minute signed reads. The editor can renew a preview without replacing unsaved text/settings. The existing Google publisher resolves the bucket from the new path namespace and still streams 8 MiB Google resumable chunks; new-bucket reads require a matching HTTP 206 range response. Legacy media behavior is unchanged.

## Cancellation, uncertainty and cleanup

Closing the editor pauses transport, not a publishing job. Cancel aborts the local transport and marks only the selected session cancelled; it never deletes an existing attachment or claims a submitted publication was cancelled. Cancellation cannot revoke a previously issued Storage capability; a late private write can still finish, but cannot attach after cancellation.

A lost final database response is treated as uncertain. The object is retained, status can be reread and the **same session's** completion retried idempotently. A retry does not reverse a later user approval. Storage metadata/reference failures never authorize deletion or a fresh upload automatically.

The existing authenticated YouTube reconciliation route runs a small cleanup pass **after** its normal reconciliation; no cron schedules or new workers are added. Only session-owned objects with no reference in any protected asset/generation registry are claimable. A transactional deletion state prevents late attachment while deletion is in progress. Storage errors retain durable retry state. Cleanup failure is reported as deferred and does not interrupt existing publication processing.

Cleanup waits **51 hours from initial allocation**, covering the last permitted grant (at 24 hours), its two-hour validity, the maximum 24-hour TUS URL lifetime and an additional clock/processing margin. Active attachments remain protected regardless of age. Failed/abandoned/replaced session uploads are cleaned after that grace; owner/draft deletion leaves the private cleanup receipt until the orphan is removed. Deleted receipts are pruned after seven further days. Supabase owns unfinished TUS-part lifecycle: verify actual service-side reclamation in staging; do not claim our object deletion API deletes invisible multipart state.

Legacy pre-0066 media paths are not scanned/deleted by the new cleaner. They retain existing conservative cleanup behavior; replacing a legacy attachment through this flow can retain an old unreferenced legacy object. This is a deliberate fail-safe retention limitation, not permission for an unproven global media purge. Registered new uploads have durable cleanup; any broader legacy cleanup requires separately reviewed protection of concurrent legacy writes.

## Migration and infrastructure prerequisites

`0066_youtube_resumable_uploads.sql` depends on existing 0064 plus earlier approval/credit infrastructure, **not on the unmerged 0065**. It creates one private session table, three supporting indexes/unique constraints, the private bucket and seven server-only lifecycle RPCs. It widens the asset metadata size constraint only for native MP4 paths, and extends the existing attachment operation without changing its signature/legacy behavior. The exact previous function is retained privately (no service/browser execute permission) for a guarded rollback.

The migration is transaction-wrapped and one-time, not a bulk `db push`. It does not backfill customer data, change existing buckets, enable workers, change provider credentials or invoke external APIs. Constraint validation can scan `post_draft_assets`; preflight row counts/locks and use short lock/statement timeouts. Stop on a partial installation or unexpected pre-existing bucket/function name.

`supabase/rollbacks/0066_youtube_resumable_uploads.sql` restores the prior attachment implementation and 20 MiB legacy metadata constraint **only when there are no sessions, new-path assets, large assets or Storage objects in the new bucket**. It deletes no uploaded files. Rollback is prohibited after use; prefer a forward fix. Stop new app/cleanup callers first and obtain separate approval.

### Confirmed configuration gate — do not silently change it

A read-only, identity-verified Management API check on 30 October 2026 found Production `spqkkbznzxxkdtexyqzh` currently has a **52,428,800-byte (50 MiB) GLOBAL Storage limit**. The existing `mara-media` migration specifies 500 MiB, but that does **not override** the global limit. Supabase Pro can support 256 MiB, but the setting is not currently enabled. Nothing was changed.

**This release preserves the verified 50 MiB effective cap.** The later effective-limit implementation below supersedes the original 256 MiB release plan. Do not raise the organisation spend cap, global Storage limit or `YOUTUBE_UPLOAD_MAX_BYTES` above 52428800. Any future higher-limit release requires separate approval and hosted validation, preserving unrelated buckets' effective limits.

The runtime verifies the new bucket is private with its expected internal ceiling before issuing authorization and separately enforces the 50 MiB effective limit. It does not embed a Management API credential to change/read account-level configuration. Confirm the effective limit is unset (safe 50 MiB default) or explicitly 52428800 during deployment preflight. Missing migration/storage readiness fails closed without exposing any public bucket.

## Focused local acceptance and remaining staging work

Local regression suites exercise actual migration SQL through embedded PostgreSQL, mocked Storage/provider boundaries, exact owner/draft attachment, Shorts rules, stale versions, approval invalidation, post-worker ownership, cancellation, lost final response, quotas, storage uncertainty, capability-safe cleanup, existing credits/media and guarded rollback/reapplication. A real TUS client talks to a loopback-only mock Storage server, loses an acknowledged chunk response and resumes from the server offset without another logical object or corrupt bytes.

Rendered checks use the actual React upload component and actual TUS library in a synthetic localhost harness (Browser plugin not available; existing Playwright with a temporary headless installed Chrome context). Desktop 1366×600 and mobile 320×640 cover pause, reload + same-file resume, recovery, invalid-file message, cancellation, progress, no horizontal overflow and no runtime errors. The existing original six-second MP4 plays in the local preview. This is **not** a hosted authenticated Supabase/TUS integration test or an app-wide visual acceptance claim.

Original staging checklist (historical; see hosted results and current release gates below):

1. An isolated staging preflight of 0066/bucket/global limits and a usable recovery point; apply only 0066, preserving the unrelated installed 0065 and existing data/policies/cron inventory.
2. Staging-only global-cap configuration (if needed) and a protected deployment with publishing/AI workers disabled. Preserve other buckets' effective limits.
3. Real direct signed-TUS uploads at sizes above 4 MiB, at the chosen cap and cap+1; malicious declared-size/file metadata attempts; token expiry, cancellation, reload, offset conflicts, CORS, expired TUS URLs and unfinished-part reclamation; verify no write can overwrite the immutable final object.
4. Independent PostgreSQL sessions for finalize/cancel/cleanup/worker-claim races, fail-closed reference lookup faults, clean rollback refusal after data exists, and media persistence/renewed preview. Use only synthetic owner records and original media, never Google uploads or provider tokens.
5. Exact cleanup of staging fixtures after capability expiry or an approved isolated-store disposal procedure. Do not force-delete a bucket/active media just to make a test look clean.

No staging or Production migration/configuration was applied during the original local implementation. The subsequent hosted section records the owner-applied staging migration. Production rollout remains separately gated.

Sources: [Supabase resumable uploads](https://supabase.com/docs/guides/storage/uploads/resumable-uploads), [upload limits](https://supabase.com/docs/guides/storage/uploads/file-limits), [incremental SHA-256 API](https://github.com/paulmillr/noble-hashes).

## Final local checks (30 October 2026, Claude Code continuation)

Codex's implementation was continued, not rewritten. Additions:

- `tests/youtube-upload-editor.test.mjs`: the real editor component and real browser `tus-js-client` build in Chromium against a loopback-only synthetic Storage/TUS + upload API. Covers pause (no further acknowledged bytes) and resume from the server offset on the same object; closing/reopening the editor and resuming only with the same original bytes (a changed file is refused without a new session/object); automatic recovery from a lost chunk response; an expired grant pausing and resuming with a fresh grant; cancel stopping transfer, never attaching and leaving no stale controls. Each was checked to fail when the corresponding component behaviour is removed.
- `tests/youtube-resumable-upload.test.mjs`: another owner cannot authorize, complete, cancel or read an upload; guarded rollback also refuses when the bucket holds objects or a large asset exists.
- Fixed a regression: the editor now imports `tus-js-client`, and the rendered-test bundler resolved its Node build (`fs`), breaking every rendered suite that bundles the editor. `tests/helpers/client-bundle.mjs` now maps it to its browser build, as Next does. The production build was never affected.
- Reviewed-migration pins (`post-studio`, `post-studio-production-0021`, `multi-social-core`) now list 0066 deliberately; 0065 stays reserved for the separate compliance release. The post-studio provider scan treats the direct-upload suite like the existing native-upload suite (auth/storage substituted, only `storage.invalid` HTTP).

Results: focused upload/provider/migration suites 204/204; full suite 2036 pass / 21 fail / 4 skipped. The same 20 failures occur on a clean export of main `e322af0`; the 21st (`rolling-plan channel assignment requires no database migration`) compares against the stale local `main` ref, flags only the already-merged 0063, and is skipped without git history. TypeScript, changed-file lint, `git diff --check` and a clean production build pass; client chunks contain the browser TUS build and no service-role reference.

SHA-256 (superseded by the compatibility revision below).

### Higher-limit configuration (OUT OF SCOPE; NOT applied)

Do not increase any Storage setting or billing/spend cap for this release. Raising the global limit would also broaden other buckets' effective limits, including `mara-media` and `instagram-media`. The internal schema ceiling is not evidence of hosted support. A future higher-limit release must be reviewed and tested separately.

### Schema-history compatibility revision (30 October 2026)

0066 no longer drops the media size check by name. It finds the single `post_draft_assets` check that only bounds `byte_size` (`CHECK (byte_size >= 1 AND byte_size <= N)`), keeps its name and its limit N for every other upload, and adds only the native-YouTube MP4 allowance (≤ 268,435,456 bytes on `<owner>/youtube-uploads/<uuid>.mp4`). Any other byte_size check, more than one, or N ≥ 256 MiB stops the migration with nothing applied. Result: main keeps 20 MiB, a drifted Production keeps its own limit (tested with a renamed 4 MiB check), and staging keeps 0060's 50 MB check under 0060's name.

Where staging's TikTok 0060 trigger exists, 0066 extends it only if its body is byte-identical to the reviewed 0060 (fixture `tests/fixtures/staging-0060_tiktok_video_upload_50mb.sql`, sha256 37b41b73…92ae, matching the staging record); otherwise it stops. The extension lets a native YouTube path exceed 20 MB only for the same owner's YouTube video/Short draft, and refuses any other draft's large asset on a YouTube path. TikTok (50 MB MP4), Instagram and legacy YouTube paths (20 MB) are unchanged. Where 0060 never ran, no trigger is created.

The rollback restores the same-named check with the environment's own limit and, on staging, 0060's exact trigger body; it still refuses while sessions, native YouTube assets, assets above that limit, or bucket objects exist.

Tests: `tests/youtube-upload-migration-histories.test.mjs` (Production-compatible drift, staging with 0060, unexpected shapes stop cleanly, rollback restoration, existing rows intact). Focused suites 288/289 (the one failure is the stale-local-`main` test); full suite failures identical to main `e322af0` plus that test; TypeScript, lint, `git diff --check` pass.

SHA-256: migration 0066 `ce70685585713b55a1084b346c4fc8007ebcb25666e3c003a5519f1b705c731b`; rollback `c9a177450ce2e3c2e082a403695434b2ac28285cafe2ae175db6bb773eb692c5`.

### Release configuration: effective upload limit (30 October 2026)

The 256 MiB architecture (bucket, 0066 constraint, validation) is unchanged. Hosted Storage, however, accepts only up to each project's GLOBAL limit: 52,428,800 bytes (50 MiB; the dashboard shows "50 MB") on Production and staging while the organisation spend cap is on.

- Server-only `YOUTUBE_UPLOAD_MAX_BYTES` sets the effective limit. Unset or invalid (non-integer, ≤0, > 268,435,456) → **52,428,800 bytes**. Only set it to 268435456 after the target project's global limit is raised.
- `GET /api/posts/[id]/video-upload` returns `maxBytes`; the editor shows "MP4 up to N MB" (whole MiB, so it never overstates) and refuses a larger file before hashing or uploading.
- `start` refuses a larger file with `upload_too_large` (413) before any session is created; `authorize` refuses a pending session larger than the current limit before any Storage grant is issued.
- Tests: route default/override/invalid configuration, exact 52,428,800 accepted and 52,428,801 refused, no grant after lowering; Chromium editor refusal with no session and no bytes sent.

## Hosted staging acceptance (30 October 2026, staging `qcdpegwjofrqnfudyrqq` only)

Applied once by the owner in the staging SQL editor: 0066 (sha256 ce706855…5c731b), verified by a 14-point read-only check. Global Storage limit unchanged at 52,428,800 bytes (50 MiB; dashboard "50 MB") because the organisation spend cap stays on. **256 MiB hosted uploads are NOT verified.**

Defect found and fixed: signed TUS uploads were sent to `/storage/v1/upload/resumable` with only `x-signature`; hosted Storage answered 400 AccessDenied "Invalid Compact JWS". They now use `/storage/v1/upload/resumable/sign` with the public `apikey` plus `x-signature` (as the TikTok sandbox uploader does), and fail closed without a public key.

Local app (`next start` on 127.0.0.1, staging-only env, no provider/cron/YouTube settings) + real `tus-js-client` + real staging Storage, two synthetic users, six private unscheduled YouTube drafts, original H.264 1280×720 6 s test video padded with an MP4 `free` box:

| Check | Result |
|---|---|
| 10,485,760-byte upload attaches to the exact draft | PASS |
| Private preview: signed staging URL, 206 range, exact bytes; file plays (AVFoundation) | PASS |
| Persistence across reloads and a fresh sign-in; renewed preview, same bytes | PASS |
| Replacement withdraws approval (approved → draft, version cleared), keeps copy, keeps previous file | PASS |
| Pause at 6,291,456 bytes; server offset matches; incomplete file not attachable | PASS |
| Mid-chunk interruption at 18,939,904 sent → resumed from server offset 18,874,368 on the same upload URL; 26,214,400 bytes stored, SHA-256 match | PASS |
| Cancel: no new grant (409); a late write with the old grant lands but cannot attach (409) | PASS |
| Forged grant, other path, other bucket, overwrite of the stored file: all refused by Storage | PASS |
| Other user / anonymous: API 409/404/401; direct download, signed URL, list, public URL all denied | PASS |
| Cleanup claims nothing within the 51 h grace; attached and previous files intact | PASS |
| Exactly 52,428,800 bytes uploads and attaches | PASS |
| 52,428,801 bytes: app refuses (413 `upload_too_large`) before any session | PASS |
| With the app limit lifted locally: Storage itself refuses 52,428,801 bytes (413 "Maximum size exceeded"); nothing attaches | PASS |
| Nothing queued for YouTube, generated or charged | PASS |

Not verified on hosted staging: 256 MiB uploads; real two-hour grant expiry (grant TTL observed 7,200 s; expired/forged grants refused locally and forged on hosted); deletion by the cleanup worker after its 51-hour grace (service role cannot shorten it by design).

Fixtures removed: users 2/2 per run, drafts/assets 0, bucket objects 0. Ten orphaned `youtube_upload_sessions` rows (owner/draft already null, no objects) remain because the service role has no DELETE on that table by design; remove them in the SQL editor (IDs recorded in the session notes) or let the cleaner retire them after 51 h + 7 days.

## Current release gates — Codex handover review

Release-preparation checks: 55 focused upload/native-upload/schema-history tests passed, zero failed; TypeScript, changed-file lint and `git diff --check` passed. The separate cleanup starvation probe below reproduced a new defect outside the existing passing tests. The earlier full-suite failures are recorded above; no full-suite replay or unrelated fixes were performed. Credential scanning found no staging key material in the candidate files; `.env.local` is ignored and excluded from the commit. Existing cron JSON is byte-equivalent as parsed; the only Vercel JSON change disables automatic deployment for this feature branch, matching the existing release-branch pattern.

### Confirmed cleanup starvation blocker

`claim_youtube_upload_cleanup` selects the oldest `p_limit` due sessions **before** checking protected references. Referenced sessions are skipped without advancing their scan position. Consequently, ten old, still-attached uploads can occupy every default batch indefinitely; later abandoned uploads never reach the claim operation.

Reproduced using the unchanged migration in a disposable local embedded-PostgreSQL database: insert ten older, due, attached session/asset pairs plus one later, due, unreferenced cancelled session. Three calls to `claim_youtube_upload_cleanup(10)` returned `[0, 0, 0]`; the orphan remained `cancelled`. No network, Storage or customer database was used. This is a retention/cost reliability defect, not evidence of active-media deletion.

**Do not merge until a bounded, non-starving cleanup selection is implemented and regression-tested.** Migration 0066 has already been applied on staging and its reviewed hash is unchanged; do not silently edit/reapply it. Prepare an explicitly reviewed forward migration for any installed-function correction. Migration 0065 remains reserved for the separate compliance work and must not be included or changed here.

### Time-based hosted acceptance still outstanding

- Real two-hour upload-grant expiry, reauthorization and recovery against hosted Storage (local simulated expiry already passes).
- Real post-51-hour cleanup, protection of attached media, retry recovery and unfinished TUS-part reclamation. Do not shorten staging timestamps or infer invisible multipart absence merely from an empty completed-object listing.
- The verified 50 MiB boundary is the release limit. Hosted 256 MiB testing is not required for this 50 MiB release and must not be advertised as complete.

### Synthetic cleanup approval — pending a later explicit run

On 30 October 2026 Codex independently matched all ten session IDs to Claude's test-run receipts. All owner/draft FKs were null; states were two pending, six attached, two cancelled; their three former uploading owners no longer existed. No exact-path objects or references in any of the four protected media registries remained. These observations do not prove unfinished TUS activity has expired.

The owner approved exact-ID cleanup **only after 1 November 2026, 21:34 Asia/Dubai (17:34 UTC)**, with fresh checks of identities, ownership, references, Storage and outstanding upload capabilities/TUS activity. A changed condition or uncertain activity must stop deletion. The prepared SQL is a proposal, not an execution mechanism, and must be accompanied by those checks. Cleanup remains pending for a later explicit run; no timer, automation or promise of automatic execution exists. Do not invoke general publishing workers to clean synthetic data.

### Production rollout checklist — requires separate approval

1. Resolve the cleanup blocker and the time-based hosted acceptance gaps before marking the PR ready. The branch-specific `git.deploymentEnabled` entry is false; publishing this Draft PR must not deploy it.
2. Reconfirm Production identity `spqkkbznzxxkdtexyqzh`, a usable recent recovery point, migration prerequisites and absent/partial-installation state. Recheck current schema, security grants, data/queue fingerprints and cron definitions. Do not assume staging's TikTok 0060 or compliance 0065 exists on Production.
3. Compare the migration byte-for-byte with the reviewed version. Apply only explicitly approved SQL transactionally, with short lock/statement timeouts and no conflicting schema transaction; never use bulk `db push`. 0066's constraint validation can scan/lock `post_draft_assets`. Verify private bucket, RLS, restricted RPC grants, unchanged legacy limits and preserved data after application. Any forward cleanup migration needs its own staging/Production approval.
4. Preserve all Production secrets, existing provider settings and schedules. Keep the effective upload maximum unset (50 MiB default) or 52428800; do not raise the global Storage limit/spend cap. Confirm the existing authenticated YouTube reconcile schedule targets the current Production deployment, since it also drives deferred upload cleanup; no new schedule is added here.
5. Only after migration/configuration verification and explicit merge/deploy approval, release the reviewed code through the normal pipeline. Verify Ready, authenticated editor availability, safe 50 MiB display and private previews without uploading real customer media, charging credits or invoking Google publishing. Reconfirm other integrations and schedules are unchanged.
6. Rollback SQL is forbidden once upload sessions/objects/assets exist. Prefer a forward fix; do not roll back the app to a worker that cannot resolve the new bucket if new-bucket publishing work exists. Pause/coordinate only affected work through separately authorized controls before any recovery.
