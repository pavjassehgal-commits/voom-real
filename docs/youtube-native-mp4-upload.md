# Native YouTube MP4 uploads

This change reuses `POST /api/posts/[id]/asset`, the private `mara-media`
bucket and `post_draft_assets`. Both `youtube_video` and `youtube_short`
editors expose Upload video and an owner-only, 15-minute signed preview.
Uploading never calls an AI/provider API, charges credits, approves content,
or creates a publishing job. Existing explicit approval, privacy/audience
declarations and YouTube resumable publishing remain the execution boundary.

## Limits and replacement safety

- MP4 signature, video track, dimensions and duration are checked server-side.
- YouTube uploads are limited to 4 MiB, below Vercel's 4.5 MB multipart request
  limit. Other integrations' existing upload limits are unchanged. Larger
  uploads require a separately reviewed extension to the shared uploader.
- Shorts must be square/vertical and at most 180 seconds.
- Media replacement invalidates approval and any old synthetic declaration,
  cancels only the draft's unsubmitted queue work, and preserves copy,
  hashtags, script, proposed time, privacy and COPPA choice.
- Claimed, submitted and published jobs, including failed resumable sessions,
  cannot have their media replaced. Active/uncertain AI jobs also block it.
- Identical-byte retries are idempotent. Uncertain writes tell the owner to
  reload first; reference-check failures never authorize media deletion.

## Required migration and rollout

Apply **only `0064_youtube_uploaded_video.sql`**, following database identity,
backup/recovery and compatibility preflight, before deploying this code.
It creates one service-role-only function, `attach_youtube_uploaded_video`.
There are no new tables, backfills, cron jobs or changes to existing grants,
policies or scheduled workers. The function locks/checks the owner, draft
version and queue before attaching through existing approval triggers.
The migration was applied once to `voom-staging` (`qcdpegwjofrqnfudyrqq`).
Its exact function body and service-role-only permissions were verified.
Existing data counts, queue states, table grants, policies, triggers and
TikTok cron definitions remained unchanged. It is **not applied to Production**.

Rollback: deploy the previous application code first, then (with separate
database approval) drop only
`public.attach_youtube_uploaded_video(uuid,uuid,bigint,text,text,bigint)`.
Do not delete `post_draft_assets`, private media or existing credit records.

## Validation

`tests/youtube-native-upload.test.mjs` exercises the actual route/data layer
and unmodified migrations in disposable PGlite, with auth/storage test doubles
and external HTTP blocked. It covers native formats, spoofed/invalid/oversize
files, owner isolation, service-only grants, stale versions, worker-claim
interleaving, uncertain writes, active generation, approval invalidation and
the existing worker's private ranged-media reader. Existing publishing,
media-inspection and Post Studio regression suites run alongside it.

The real editor was also bundled into an isolated loopback browser harness
using real app CSS, the actual upload route and local PostgreSQL fixtures.
The original 6-second, 1280×720 MP4 uploaded, decoded/played and remained
attached after reload. Desktop, short-laptop, 390px and 320px checks passed;
Shorts rejected that landscape file. No external services or real users were
used. Local fixture transactions were rolled back and the browser/server shut
down. Real hosted storage and YouTube uploading still require the separately
approved staging/release acceptance step.

Final local results: 371 focused tests passed, zero failed; the finalized
28-case upload suite was rerun after the SQL lock-order review and passed.
TypeScript, changed-file lint and the isolated Production build passed.
An additional historical LinkedIn release-config assertion fails because it
expects exactly two disabled branches in `vercel.json`, while current main
already contains six. Both that test and `vercel.json` are unchanged from
main; this is not a publishing regression and was not repaired in this task.
The release adds only this feature branch to `git.deploymentEnabled: false`
to prevent an automatic generic Preview with inherited Production settings.
Existing branch entries and all Production cron schedules are preserved.

## Safest future path for larger videos (not implemented here)

Extend the **same authenticated uploader** with a short-lived, owner/draft-bound
Supabase signed-upload ticket. Send bytes directly to the existing private
bucket, preferably resumably, instead of routing a large body through a Vercel
Function. Do not expose the service key or make the bucket public. A server-side
finalization step must verify the uploaded object's path, size and MP4 metadata,
then use the same locked attachment/version/approval checks before the asset is
publishable. Incomplete or unvalidated uploads remain unusable. Raise the
database cap only as part of that separately reviewed change. Existing signed
previews and the YouTube worker's ranged/resumable reader can be reused.

Migration SHA-256:
`c2beaad1a8119cc23df62dde63b472d1ffbb6c3e6af9083efe3cebd3fc9b2a87`.
