import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const pub = await import("../lib/instagram/publishing.ts");
const core = await import("../lib/post/core.ts");

const OWNER = "11111111-1111-4111-8111-111111111111";
const DRAFT = "33333333-3333-4333-8333-333333333333";
const NOW = Date.parse("2026-09-06T12:00:00.000Z");

// ---------------------------------------------------------------------------
// Media routing — which Meta container a Story draft's asset publishes through
// ---------------------------------------------------------------------------

test("a Story image routes to the story media kind (Meta STORIES container)", () => {
  assert.equal(pub.publishMediaKindForMime("image/jpeg", "story"), "story");
  assert.equal(pub.publishMediaKindForMime("image/png", "story"), "story");
});

test("a Story video routes to the story media kind — Meta supports video Stories", () => {
  assert.equal(pub.publishMediaKindForMime("video/mp4", "story"), "story");
});

test("a webp Story asset never routes anywhere — Instagram will not ingest webp", () => {
  assert.equal(pub.publishMediaKindForMime("image/webp", "story"), null);
  assert.equal(pub.isPublishableMime("image/webp"), false);
});

test("a MOV Story asset is recognised as a story kind but never enqueued for publish", () => {
  // Meta's publishing API takes MP4 video; a stored quicktime file maps to the
  // story kind but is blocked by the publishable-mime gate at enqueue time.
  assert.equal(pub.publishMediaKindForMime("video/quicktime", "story"), "story");
  assert.equal(pub.isPublishableMime("video/quicktime"), false);
});

test("existing Post and Reel routing is unchanged by Story support", () => {
  assert.equal(pub.publishMediaKindForMime("image/jpeg", "instagram_post"), "image");
  assert.equal(pub.publishMediaKindForMime("image/png", "instagram_post"), "image");
  assert.equal(pub.publishMediaKindForMime("video/mp4", "reel"), "reel");
  assert.equal(pub.publishMediaKindForMime("image/jpeg", "reel"), null);
  assert.equal(pub.publishMediaKindForMime("video/mp4", "instagram_post"), "reel");
});

test("video mimes are classified for asynchronous transcode polling", () => {
  assert.equal(pub.isVideoPublishMime("video/mp4"), true);
  assert.equal(pub.isVideoPublishMime("video/quicktime"), true);
  assert.equal(pub.isVideoPublishMime("image/jpeg"), false);
  assert.equal(pub.isVideoPublishMime("image/png"), false);
});

test("the queue labels all three Instagram content kinds", () => {
  assert.equal(pub.PUBLISH_MEDIA_KIND_LABELS.story, "Story");
  assert.equal(pub.PUBLISH_MEDIA_KIND_LABELS.reel, "Reel");
  assert.equal(pub.PUBLISH_MEDIA_KIND_LABELS.image, "Instagram Post");
});

// ---------------------------------------------------------------------------
// Claiming — future Story not claimed, due Story claimed
// ---------------------------------------------------------------------------

const storyRow = (overrides = {}) => ({
  status: "scheduled",
  scheduledAt: "2026-09-06T11:55:00.000Z",
  draftStatus: "approved",
  attempts: 0,
  instagramMediaId: null,
  ...overrides,
});

test("a due, approved Story is claimable by the same worker run", () => {
  assert.equal(pub.isDueForPublishing(storyRow(), NOW), true);
});

test("a future Story is never claimed early", () => {
  assert.equal(pub.isDueForPublishing(storyRow({ scheduledAt: "2026-09-06T13:00:00.000Z" }), NOW), false);
});

test("a Story with no schedule, or an unapproved draft, is not claimed", () => {
  assert.equal(pub.isDueForPublishing(storyRow({ scheduledAt: null }), NOW), false);
  assert.equal(pub.isDueForPublishing(storyRow({ draftStatus: "draft" }), NOW), false);
  assert.equal(pub.isDueForPublishing(storyRow({ draftStatus: "rejected" }), NOW), false);
});

test("a Story that exhausts its attempts is not claimed again", () => {
  assert.equal(pub.isDueForPublishing(storyRow({ attempts: pub.MAX_PUBLISH_ATTEMPTS }), NOW), false);
});

test("a Story parked as waiting_for_media is reclaimed once its retry time is due", () => {
  const at = pub.retryAt(1, NOW);
  const row = storyRow({ status: "waiting_for_media", scheduledAt: at, attempts: 1 });
  assert.equal(pub.isDueForPublishing(row, NOW), false);
  assert.equal(pub.isDueForPublishing(row, Date.parse(at) + 1), true);
});

test("a claimed Story still in flight is not re-claimed until the claim is stale", () => {
  const row = storyRow({ status: "publishing", claimedAt: "2026-09-06T11:59:00.000Z" });
  assert.equal(pub.isDueForPublishing(row, NOW), false);
  assert.equal(pub.isDueForPublishing(storyRow({ status: "publishing", claimedAt: "2026-09-06T11:30:00.000Z" }), NOW), true);
});

test("a Story keeps the same one-per-draft publish identity as Posts and Reels", () => {
  const key = pub.publishIdempotencyKey(DRAFT);
  assert.equal(key, `igpub_${DRAFT.replace(/-/g, "")}`);
  assert.equal(key, pub.publishIdempotencyKey(DRAFT));
});

// ---------------------------------------------------------------------------
// The real Story publish sequence, exercised end to end with fake ports.
// ---------------------------------------------------------------------------

const { runPublishFlow } = await import("../lib/instagram/publish-flow.ts");

function makePorts(overrides = {}) {
  const calls = { containers: [], publishes: [], statuses: 0, published: [], failed: [], signed: [] };
  const ports = {
    calls,
    async loadDraft() { return { status: "approved", content: "Story concept" }; },
    async loadConnection() {
      return { status: "connected", scopes: ["instagram_business_basic", "instagram_business_content_publish"], tokenExpiresAt: null };
    },
    async loadCredentials() { return { igUserId: "178414", accessToken: "TOKEN" }; },
    async loadAsset() { return { storagePath: `${OWNER}/post-assets/abc-${DRAFT}.jpg`, mimeType: "image/jpeg", status: "uploaded" }; },
    async signMediaUrl(path) { calls.signed.push(path); return `https://signed.example/${path}?token=x`; },
    async createContainer(input) { calls.containers.push(input); return `container-${calls.containers.length}`; },
    async containerStatus() { calls.statuses += 1; return "FINISHED"; },
    async publishContainer(input) { calls.publishes.push(input); return "17900001"; },
    async findPublishedMediaId() { return null; },
    async persistContainerId(item, containerId) { item.containerId = containerId; },
    async markPublished(item, mediaId, containerId) { calls.published.push({ mediaId, containerId }); item.instagramMediaId = mediaId; },
    async markFailed(item, input) { calls.failed.push(input); },
    async sleep() {},
    now: () => NOW,
    ...overrides,
  };
  return ports;
}

const storyItem = () => ({
  id: "queue-story-1", ownerUserId: OWNER, draftId: DRAFT, mediaKind: "story",
  caption: "", attempts: 1, containerId: null, instagramMediaId: null,
});

test("image Story publishing: STORIES container → readiness → media_publish → real media id", async () => {
  const ports = makePorts();
  const result = await runPublishFlow(storyItem(), ports);
  assert.equal(result.outcome, "published");
  assert.equal(result.mediaId, "17900001");
  assert.equal(ports.calls.containers.length, 1);
  assert.equal(ports.calls.containers[0].kind, "story");
  assert.equal(ports.calls.containers[0].video, false, "an image Story is not video");
  assert.match(ports.calls.containers[0].mediaUrl, /^https:\/\/signed\.example\//);
  assert.equal(ports.calls.containers[0].caption, "", "Meta Story containers have no caption parameter");
  assert.equal(ports.calls.publishes.length, 1);
  assert.deepEqual(ports.calls.published, [{ mediaId: "17900001", containerId: "container-1" }]);
  assert.equal(ports.calls.failed.length, 0);
});

test("video Story publishing waits for Meta to finish transcoding, like a Reel", async () => {
  const sequence = ["IN_PROGRESS", "IN_PROGRESS", "FINISHED"];
  let index = 0;
  const slept = [];
  const ports = makePorts({
    async loadAsset() { return { storagePath: `${OWNER}/post-assets/abc-${DRAFT}.mp4`, mimeType: "video/mp4", status: "uploaded" }; },
    async containerStatus() { return sequence[Math.min(index++, sequence.length - 1)]; },
    async sleep(ms) { slept.push(ms); },
  });
  const result = await runPublishFlow(storyItem(), ports);
  assert.equal(result.outcome, "published");
  assert.equal(ports.calls.containers[0].kind, "story");
  assert.equal(ports.calls.containers[0].video, true, "a video Story is video");
  assert.equal(slept.length, 2, "Voom must poll while the video Story is IN_PROGRESS");
  assert.equal(ports.calls.publishes.length, 1);
});

test("a missing publish permission never publishes a Story and reports the actionable state", async () => {
  const ports = makePorts({
    async loadConnection() { return { status: "connected", scopes: ["instagram_business_basic"], tokenExpiresAt: null }; },
  });
  const result = await runPublishFlow(storyItem(), ports);
  assert.equal(result.outcome, "failed");
  assert.equal(result.code, "publish_permission_required");
  assert.equal(ports.calls.failed[0].status, "permission_required");
  assert.match(ports.calls.failed[0].message, /instagram_business_content_publish/);
  assert.equal(ports.calls.containers.length, 0);
  assert.equal(ports.calls.publishes.length, 0);
});

test("a video Story still processing is parked for a later cron run, never falsely published", async () => {
  const ports = makePorts({
    async loadAsset() { return { storagePath: "story.mp4", mimeType: "video/mp4", status: "uploaded" }; },
    async containerStatus() { return "IN_PROGRESS"; },
  });
  const item = storyItem();
  const run1 = await runPublishFlow(item, ports);
  assert.equal(run1.outcome, "retrying");
  assert.equal(run1.code, "container_timeout");
  assert.equal(ports.calls.publishes.length, 0);
  assert.equal(ports.calls.published.length, 0);
  const parked = ports.calls.failed[0];
  assert.equal(parked.status, "scheduled");
  assert.ok(parked.retryAt, "a retry time must be persisted");

  // The parked row must be reclaimable by a later cron run once due.
  const stored = { status: parked.status, scheduledAt: parked.retryAt, draftStatus: "approved", attempts: 2, instagramMediaId: null };
  assert.equal(pub.isDueForPublishing(stored, NOW), false);
  assert.equal(pub.isDueForPublishing(stored, Date.parse(parked.retryAt) + 60_000), true);

  // And once Meta has finished, the retry publishes exactly once, reusing the
  // stored container instead of creating a second Story.
  const second = makePorts({
    async loadAsset() { return { storagePath: "story.mp4", mimeType: "video/mp4", status: "uploaded" }; },
    async containerStatus() { return "FINISHED"; },
  });
  const run2 = await runPublishFlow({ ...item, attempts: 2 }, second);
  assert.equal(run2.outcome, "published");
  assert.equal(second.calls.containers.length, 0, "the container is reused, never re-created");
  assert.equal(second.calls.publishes.length, 1);
  assert.equal(item.containerId, "container-1");
});

test("a Story with no stored visual parks as waiting_for_media, then publishes once it arrives", async () => {
  const first = makePorts({ async loadAsset() { return null; } });
  const run1 = await runPublishFlow(storyItem(), first);
  assert.equal(run1.outcome, "retrying");
  assert.equal(first.calls.failed[0].status, "waiting_for_media");

  const second = makePorts();
  const run2 = await runPublishFlow({ ...storyItem(), attempts: 2 }, second);
  assert.equal(run2.outcome, "published");
  assert.equal(second.calls.publishes.length, 1);
});

test("an already-published Story is never published again", async () => {
  const ports = makePorts();
  const result = await runPublishFlow({ ...storyItem(), instagramMediaId: "17900001" }, ports);
  assert.equal(result.outcome, "published");
  assert.equal(result.mediaId, "17900001");
  assert.equal(ports.calls.containers.length, 0);
  assert.equal(ports.calls.publishes.length, 0);
});

test("a duplicate cron execution over the same Story creates exactly one Instagram Story", async () => {
  const ports = makePorts();
  const item = storyItem();
  const first = await runPublishFlow(item, ports);
  const second = await runPublishFlow(item, ports);
  assert.equal(first.outcome, "published");
  assert.equal(second.outcome, "published");
  assert.equal(ports.calls.publishes.length, 1, "media_publish must be called exactly once");
  assert.equal(ports.calls.containers.length, 1);
});

test("an unsupported Story file type is never sent to Instagram", async () => {
  const ports = makePorts({ async loadAsset() { return { storagePath: "p.webp", mimeType: "image/webp", status: "uploaded" }; } });
  const result = await runPublishFlow(storyItem(), ports);
  assert.equal(result.outcome, "failed");
  assert.equal(result.code, "media_unsupported");
  assert.equal(ports.calls.containers.length, 0);
});

// ---------------------------------------------------------------------------
// The client sends exactly Meta's current Story container request.
// ---------------------------------------------------------------------------

test("the Instagram client implements Meta's current STORIES container request", async () => {
  const client = await read("lib/instagram/client.ts");
  assert.match(client, /createStoryContainer/);
  assert.match(client, /media_type: "STORIES"/);
  // Image Story containers take image_url; video Story containers take video_url.
  assert.match(client, /\[input\.video \? "video_url" : "image_url"\]: input\.mediaUrl/);
  // The Story container body must never include a caption parameter.
  const storyBody = client.slice(client.indexOf("async createStoryContainer"));
  const bodyEnd = storyBody.indexOf("async getContainerStatus");
  const storyMethod = storyBody.slice(0, bodyEnd);
  assert.doesNotMatch(storyMethod, /caption/);
});

test("the worker routes story items to the STORIES container call", async () => {
  const worker = await read("lib/instagram/publish-worker.ts");
  assert.match(worker, /input\.kind === "story"[\s\S]*?createStoryContainer/);
  assert.match(worker, /createReelContainer/);
  assert.match(worker, /createImageContainer/);
});

test("the publish flow never sends caption text for a Story", async () => {
  const flow = await read("lib/instagram/publish-flow.ts");
  assert.match(flow, /item\.mediaKind === "story" \? "" : truncateCaption/);
});

test("Stories are enqueued without a caption because Meta Stories do not support one", async () => {
  const data = await read("lib/post/server-data.ts");
  assert.match(data, /caption: mediaKind === "story" \? "" : truncateCaption\(view\.composedCaption\)/);
});

// ---------------------------------------------------------------------------
// Draft kind, format, approval and calendar plumbing
// ---------------------------------------------------------------------------

test("story is a valid Post Studio draft kind with the 9:16 Story format", () => {
  assert.equal(core.STORY_DRAFT_KIND, "story");
  assert.ok(core.isPostDraftKind("story"));
  assert.ok(core.isPostDraftKind("instagram_post"));
  assert.ok(core.isPostDraftKind("reel"));
  assert.equal(core.isPostFormat("9:16"), true);
  assert.equal(core.formatAspectRatio("9:16"), "9 / 16");
  assert.ok(core.POST_FORMATS.includes("9:16"));
});

test("the Story format is locked to Stories and never leaks onto a feed post", () => {
  assert.equal(core.formatForKind("story", "1:1"), "9:16");
  assert.equal(core.formatForKind("story", "9:16"), "9:16");
  assert.equal(core.formatForKind("instagram_post", "9:16"), "1:1");
  assert.equal(core.formatForKind("instagram_post", "4:5"), "4:5");
  assert.equal(core.formatForKind("reel", "9:16"), "1:1");
});

test("a Story draft encodes and decodes its channel and format like Posts and Reels", () => {
  const channel = core.encodeDraftChannel("story", "9:16");
  assert.equal(channel, "Story · 9:16");
  assert.equal(core.baseChannelFromDraftChannel(channel), "Story");
  assert.equal(core.decodeDraftFormat(channel), "9:16");
  assert.equal(core.calendarChannelFor("story"), "Story");
  assert.equal(core.baseChannelFor("story"), "Story");
});

test("Stories are always labelled as Stories, whatever the asset origin", () => {
  assert.equal(core.postTypeLabel("story", null), "Instagram Story");
  assert.equal(core.postTypeLabel("story", "uploaded_existing"), "Instagram Story");
  assert.equal(core.postTypeLabel("story", "uploaded_asset"), "Instagram Story");
  assert.equal(core.postTypeLabel("reel", null), "Reel");
  assert.equal(core.postTypeLabel("instagram_post", null), "Instagram Post");
  assert.equal(core.postTypeLabel("instagram_post", "uploaded_existing"), "Existing content");
});

test("a Story accepts an image or a video asset; a feed post stays image-only", () => {
  assert.deepEqual(core.allowedAssetKindsFor("story"), ["image", "video"]);
  assert.deepEqual(core.allowedAssetKindsFor("reel"), ["image", "video"]);
  assert.deepEqual(core.allowedAssetKindsFor("instagram_post"), ["image"]);
});

test("a Story needs a visual to be approved but no caption — Stories have none", () => {
  assert.deepEqual(core.postApprovalBlockers({ caption: "", hasVisual: false, kind: "story" }), [
    "Add an image or video before approving. Instagram Stories need one.",
  ]);
  assert.deepEqual(core.postApprovalBlockers({ caption: "", hasVisual: true, kind: "story" }), []);
  // Posts and Reels keep requiring a caption.
  assert.ok(core.postApprovalBlockers({ caption: "", hasVisual: true, kind: "instagram_post" }).length === 1);
});

test("the create-content API accepts the story kind and the 9:16 format", async () => {
  const route = await read("app/api/posts/route.ts");
  assert.match(route, /kind: z\.enum\(\["instagram_post", "reel", "story"\]\)/);
  assert.match(route, /format: z\.enum\(\["1:1", "4:5", "9:16"\]\)/);
});

test("the approval route passes the draft kind into the blockers", async () => {
  const route = await read("app/api/posts/[id]/route.ts");
  assert.match(route, /postApprovalBlockers\(\{ caption: existing\.caption, hasVisual: existing\.visualReady, kind: existing\.kind \}\)/);
});

test("MARA can create a 9:16 Story visual, with no caption step", async () => {
  const prompt = await read("lib/post/prompt.ts");
  assert.match(prompt, /STORY_VISUAL_SYSTEM_PROMPT/);
  assert.match(prompt, /storyVisualSchema/);
  const generate = await read("app/api/posts/[id]/generate/route.ts");
  assert.match(generate, /post\.kind !== "instagram_post" && post\.kind !== "story"/);
  assert.match(generate, /format: "9:16", kind: "story"/);
  assert.match(generate, /const format = post\.kind === "story" \? "9:16" : post\.format/);
  // The Story branch never composes a caption.
  const storyBranch = generate.slice(generate.indexOf('if (post.kind === "story")'), generate.indexOf("} else {"));
  assert.doesNotMatch(storyBranch, /composePostCaption/);
});

test("caption suggestions are refused for Stories — Instagram has no Story captions", async () => {
  const suggest = await read("app/api/posts/[id]/suggest/route.ts");
  assert.match(suggest, /post\.kind === "story"/);
  assert.match(suggest, /Instagram Stories don't support captions/);
});

test("Story assets are stored under the same private one-asset-per-draft rules", async () => {
  const asset = await read("app/api/posts/[id]/asset/route.ts");
  assert.match(asset, /allowedAssetKindsFor\(post\.kind\)/);
  assert.match(asset, /post\.kind === "story" \? "Instagram Story"/);
});

// ---------------------------------------------------------------------------
// Queue UI and API
// ---------------------------------------------------------------------------

test("the publishing queue API badged Stories as 'Story'", async () => {
  const route = await read("app/api/instagram/publishing-queue/route.ts");
  assert.match(route, /PUBLISH_MEDIA_KIND_LABELS\[row\.media_kind\]/);
});

test("the publishing queue UI recognises and badges Story items", async () => {
  const ui = await read("components/voom/PublishingQueue.tsx");
  assert.match(ui, /item\.type === "Story" \? "Story" : "Post"/);
  assert.match(ui, /item\.type === "Story" \? "t-story" : "t-brand"/);
  assert.match(ui, /Approve an Instagram Post, Reel or Story/);
});

test("the editor shows a 9:16 Story preview and validates Story uploads client-side", async () => {
  const editor = await read("components/voom/modals/PostEditorModal.tsx");
  assert.match(editor, /isStory/);
  assert.match(editor, /Create Story visual with MARA/);
  assert.match(editor, /checkStoryFile/);
  assert.match(editor, /STORY_MAX_VIDEO_SECONDS = 60/);
  assert.match(editor, /STORY_ASPECT = 9 \/ 16/);
  // Caption fields are hidden for Stories and a no-caption note is shown.
  assert.match(editor, /Instagram does not support captions on Stories/);
});

test("Create content offers Instagram Post, Reel and Instagram Story", async () => {
  const modal = await read("components/voom/modals/CreateContentModal.tsx");
  assert.match(modal, /title="Instagram Story"/);
  assert.match(modal, /create\("story"/);
  assert.match(modal, /type Step = "choose" \| "instagram_post" \| "reel" \| "story"/);
});

test("the Content Calendar filters and badges Story entries", async () => {
  const page = await read("app/app/(shell)/calendar/page.tsx");
  assert.match(page, /"All", "Reel", "Story", "Feed", "Email", "SMS"/);
  assert.match(page, /item\.contentType === "Instagram Story"/);
});

// ---------------------------------------------------------------------------
// Migration 0024 — the one small schema change
// ---------------------------------------------------------------------------

test("migration 0024 is the only new migration and never re-runs older ones", async () => {
  const sql = await read("supabase/migrations/0024_instagram_story_publishing.sql");
  assert.match(sql, /PREPARED FOR REVIEW/i);
  assert.match(sql, /begin;[\s\S]*commit;/);
  // It only extends constraints and replaces one RPC; no old migration rerun.
  assert.doesNotMatch(sql, /create table if not exists public\.instagram_publish_queue/);
  assert.doesNotMatch(sql, /create table if not exists public\.post_draft_assets/);
  assert.doesNotMatch(sql, /create table if not exists public\.mara_drafts/);
});

test("0024 extends the queue media_kind check with 'story'", async () => {
  const sql = await read("supabase/migrations/0024_instagram_story_publishing.sql");
  assert.match(sql, /instagram_publish_queue_media_kind_check[\s\S]*?check \(media_kind in \('image', 'reel', 'story'\)\)/);
});

test("0024 extends mara_drafts.kind and content_calendar_items.channel for Stories", async () => {
  const sql = await read("supabase/migrations/0024_instagram_story_publishing.sql");
  assert.match(sql, /mara_drafts_kind_check[\s\S]*?'story'/);
  assert.match(sql, /content_calendar_items_channel_check[\s\S]*?check \(channel in \('Instagram', 'Reel', 'Story', 'Feed', 'Email', 'SMS'\)\)/);
});

test("0024 lets the enqueue RPC accept 'story' and keeps it service-role only", async () => {
  const sql = await read("supabase/migrations/0024_instagram_story_publishing.sql");
  assert.match(sql, /create or replace function public\.upsert_instagram_publish_queue_item/);
  assert.match(sql, /p_media_kind not in \('image', 'reel', 'story'\)/);
  assert.match(sql, /security definer[\s\S]*?set search_path = ''/);
  assert.match(sql, /revoke all on function public\.upsert_instagram_publish_queue_item\(uuid, uuid, uuid, text, text, timestamptz\) from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.upsert_instagram_publish_queue_item\(uuid, uuid, uuid, text, text, timestamptz\) to service_role/);
  // The idempotent one-row-per-draft identity is untouched.
  assert.match(sql, /'igpub_' \|\| replace\(p_draft_id::text, '-', ''\)/);
});

test("0024 does not touch the claim, completion or failure functions", async () => {
  const sql = await read("supabase/migrations/0024_instagram_story_publishing.sql");
  for (const fn of [
    "claim_due_instagram_publish_jobs",
    "complete_instagram_publish_job",
    "fail_instagram_publish_job",
    "cancel_instagram_publish_queue_item",
    "record_instagram_publish_container",
  ]) {
    assert.doesNotMatch(sql, new RegExp(`(create|replace) (or replace )?function public\\.${fn}`), `0024 must not redefine ${fn}`);
  }
});

test("0022's protections still read exactly as production has them", async () => {
  const sql = await read("supabase/migrations/0022_instagram_auto_publishing.sql");
  // Stories join the same queue, so the duplicate-publish guards must be intact.
  assert.match(sql, /unique \(owner_user_id, draft_id\)/);
  assert.match(sql, /for update skip locked/);
  assert.match(sql, /instagram_publish_queue_published_is_real/);
});
