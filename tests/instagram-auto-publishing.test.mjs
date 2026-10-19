import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const pub = await import("../lib/instagram/publishing.ts");

const OWNER = "11111111-1111-4111-8111-111111111111";
const DRAFT = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-09-06T12:00:00.000Z");

// ---------------------------------------------------------------------------
// Selection: due / future / unapproved / rejected / already published
// ---------------------------------------------------------------------------

const base = {
  status: "scheduled",
  scheduledAt: "2026-09-06T11:55:00.000Z",
  draftStatus: "approved",
  attempts: 0,
  instagramMediaId: null,
};

test("a due, approved, scheduled item is selected", () => {
  assert.equal(pub.isDueForPublishing(base, NOW), true);
});

test("a future item is not selected", () => {
  assert.equal(pub.isDueForPublishing({ ...base, scheduledAt: "2026-09-06T13:00:00.000Z" }, NOW), false);
});

test("an unapproved item is never selected", () => {
  assert.equal(pub.isDueForPublishing({ ...base, draftStatus: "draft" }, NOW), false);
});

test("a rejected or cancelled item never publishes", () => {
  assert.equal(pub.isDueForPublishing({ ...base, draftStatus: "rejected" }, NOW), false);
  assert.equal(pub.isDueForPublishing({ ...base, status: "cancelled" }, NOW), false);
});

test("an item with no schedule is not selected", () => {
  assert.equal(pub.isDueForPublishing({ ...base, scheduledAt: null }, NOW), false);
});

test("an already-published item is never selected again", () => {
  assert.equal(pub.isDueForPublishing({ ...base, status: "published", instagramMediaId: "17999" }, NOW), false);
  assert.equal(pub.isDueForPublishing({ ...base, status: "scheduled", instagramMediaId: "17999" }, NOW), false);
});

test("an in-flight item is not re-claimed until its claim is demonstrably stale", () => {
  const claimed = { ...base, status: "publishing", claimedAt: "2026-09-06T11:59:00.000Z" };
  assert.equal(pub.isDueForPublishing(claimed, NOW), false);
  assert.equal(pub.isDueForPublishing({ ...claimed, claimedAt: "2026-09-06T11:30:00.000Z" }, NOW), true);
  assert.equal(pub.isDueForPublishing({ ...claimed, claimedAt: null }, NOW), false);
});

test("attempts are capped so a poison item cannot loop forever", () => {
  assert.equal(pub.isDueForPublishing({ ...base, attempts: pub.MAX_PUBLISH_ATTEMPTS }, NOW), false);
});

// ---------------------------------------------------------------------------
// State machine truthfulness
// ---------------------------------------------------------------------------

test("the publishing state machine has the required durable states", () => {
  for (const state of ["scheduled", "publishing", "published", "failed", "waiting_for_media", "permission_required"]) {
    assert.ok(pub.PUBLISH_STATES.includes(state), `${state} must exist`);
  }
  assert.equal(pub.PUBLISH_STATE_LABELS.published, "Published");
  assert.deepEqual(pub.TERMINAL_PUBLISH_STATES, ["published", "cancelled"]);
});

test("only pre-publication states claim Voom will auto-publish", () => {
  assert.equal(pub.willAutoPublish("scheduled"), true);
  assert.equal(pub.willAutoPublish("publishing"), true);
  assert.equal(pub.willAutoPublish("published"), false);
  assert.equal(pub.willAutoPublish("failed"), false);
  assert.equal(pub.willAutoPublish("cancelled"), false);
});

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

test("publishing requires instagram_business_content_publish", () => {
  assert.equal(pub.INSTAGRAM_PUBLISH_PERMISSION, "instagram_business_content_publish");
  assert.equal(pub.hasPublishPermission(["instagram_business_basic"]), false);
  assert.equal(pub.hasPublishPermission(["instagram_business_basic", "instagram_business_content_publish"]), true);
  assert.equal(pub.hasPublishPermission(null), false);
});

test("a missing publish permission is an actionable state, not a fake success", () => {
  const failure = pub.resolveFailure("permission_required", 0);
  assert.equal(failure.status, "permission_required");
  assert.match(failure.message, /Instagram publishing permission required/);
  assert.match(failure.message, /instagram_business_content_publish/);
  assert.equal(failure.retryable, false);
});

test("a missing Instagram connection fails safely and is not retried forever", () => {
  const failure = pub.resolveFailure("not_connected", 0);
  assert.equal(failure.status, "failed");
  assert.equal(failure.retryable, false);
  assert.match(failure.message, /Instagram is not connected/);
});

// ---------------------------------------------------------------------------
// Provider/container failures, processing, retries
// ---------------------------------------------------------------------------

test("a container failure is retryable and becomes terminal at the attempt cap", () => {
  const retry = pub.resolveFailure("container_failed", 1);
  assert.equal(retry.status, "scheduled");
  assert.equal(retry.retryable, true);
  const exhausted = pub.resolveFailure("container_failed", pub.MAX_PUBLISH_ATTEMPTS);
  assert.equal(exhausted.status, "failed");
  assert.equal(exhausted.retryable, false);
});

test("container processing statuses are interpreted correctly", () => {
  assert.equal(pub.isContainerReady("FINISHED"), true);
  assert.equal(pub.isContainerReady("IN_PROGRESS"), false);
  assert.equal(pub.isContainerFatal("ERROR"), true);
  assert.equal(pub.isContainerFatal("EXPIRED"), true);
  assert.equal(pub.isContainerFatal("IN_PROGRESS"), false);
  const timeout = pub.resolveFailure("container_timeout", 0);
  assert.equal(timeout.status, "scheduled");
  assert.equal(timeout.retryable, true);
});

test("a retry is parked on the worker's next cron boundary, one cadence ahead at most", () => {
  // Not `now + N minutes`: that used to land AFTER the next cron tick had
  // already run, turning a two-second miss into a five-minute delay.
  const at = Date.parse(pub.retryAt(NOW + 17_000));
  assert.equal(at, Date.parse("2026-09-06T12:04:59.000Z"), "the 12:05 boundary, minus the claim-skew margin");
  const delay = at - (NOW + 17_000);
  assert.ok(delay > 0, "a retry is never in the past");
  assert.ok(delay <= pub.PUBLISH_WORKER_PERIOD_MS, "never more than one cadence away");
});

test("failure messages are safe and never leak provider internals", () => {
  for (const failure of Object.values(pub.PUBLISH_FAILURES)) {
    assert.doesNotMatch(failure.message, /access_token|https?:\/\/|graph\.instagram/i);
    assert.ok(failure.message.length <= 400);
  }
});

// ---------------------------------------------------------------------------
// Media handling — image vs Reel
// ---------------------------------------------------------------------------

test("image and Reel media kinds are resolved from the stored asset", () => {
  assert.equal(pub.publishMediaKindForMime("image/jpeg", "instagram_post"), "image");
  assert.equal(pub.publishMediaKindForMime("image/png", "instagram_post"), "image");
  assert.equal(pub.publishMediaKindForMime("video/mp4", "reel"), "reel");
  assert.equal(pub.publishMediaKindForMime("image/webp", "instagram_post"), null);
  assert.equal(pub.isPublishableMime("image/webp"), false);
  assert.equal(pub.isPublishableMime("video/mp4"), true);
});

test("Reels get a longer readiness poll than images because Meta transcodes them", () => {
  assert.ok(pub.REEL_POLL_ATTEMPTS > pub.IMAGE_POLL_ATTEMPTS);
  assert.ok(pub.REEL_POLL_ATTEMPTS * pub.REEL_POLL_INTERVAL_MS >= 60_000);
});

test("signed media URLs live long enough for Meta to ingest", () => {
  assert.ok(pub.PUBLISH_SIGNED_URL_TTL_SECONDS >= 1800);
});

test("captions are clamped to Instagram's limit", () => {
  assert.equal(pub.truncateCaption("x".repeat(3000)).length, 2200);
  assert.equal(pub.truncateCaption("hello"), "hello");
});

// ---------------------------------------------------------------------------
// Durable publish identity
// ---------------------------------------------------------------------------

test("each scheduled draft has exactly one stable publish identity", () => {
  const key = pub.publishIdempotencyKey(DRAFT);
  assert.equal(key, pub.publishIdempotencyKey(DRAFT));
  assert.notEqual(key, pub.publishIdempotencyKey(OWNER));
  assert.ok(key.length >= 16);
});

// ---------------------------------------------------------------------------
// Migration 0022
// ---------------------------------------------------------------------------

test("migration 0022 is the only new migration and is prepared for review", async () => {
  const sql = await read("supabase/migrations/0022_instagram_auto_publishing.sql");
  assert.match(sql, /PREPARED FOR REVIEW/i);
  assert.match(sql, /begin;[\s\S]*commit;/);
  assert.match(sql, /create table if not exists public\.instagram_publish_queue/);
});

test("0022 enforces one publish identity per draft and one media id ever", async () => {
  const sql = await read("supabase/migrations/0022_instagram_auto_publishing.sql");
  assert.match(sql, /unique \(owner_user_id, draft_id\)/);
  assert.match(sql, /unique \(owner_user_id, idempotency_key\)/);
  assert.match(sql, /create unique index if not exists instagram_publish_queue_media_unique_idx[\s\S]+instagram_media_id[\s\S]+where instagram_media_id is not null/);
});

test("0022 makes 'published' impossible without a real Instagram media id", async () => {
  const sql = await read("supabase/migrations/0022_instagram_auto_publishing.sql");
  assert.match(sql, /instagram_publish_queue_published_is_real[\s\S]+check \(status <> 'published' or \(instagram_media_id is not null and published_at is not null\)\)/);
  assert.match(sql, /instagram_publish_media_id_required/);
  assert.match(sql, /instagram_publish_already_published/);
});

test("0022 claims items atomically with skip locked so a duplicate cron run publishes nothing twice", async () => {
  const sql = await read("supabase/migrations/0022_instagram_auto_publishing.sql");
  assert.match(sql, /create or replace function public\.claim_due_instagram_publish_jobs/);
  assert.match(sql, /for update skip locked/);
  assert.match(sql, /set status = 'publishing'/);
  assert.match(sql, /q\.instagram_media_id is null/);
});

test("0022 is owner-safe and RLS-safe", async () => {
  const sql = await read("supabase/migrations/0022_instagram_auto_publishing.sql");
  assert.match(sql, /alter table public\.instagram_publish_queue enable row level security/);
  assert.match(sql, /revoke all on table public\.instagram_publish_queue from public, anon, authenticated/);
  assert.match(sql, /grant select on table public\.instagram_publish_queue to authenticated/);
  assert.doesNotMatch(sql, /grant[^;]*instagram_publish_queue[^;]*(insert|update|delete)[^;]*to authenticated/i);
  assert.match(sql, /create policy "instagram_publish_queue_select_own"[\s\S]+auth\.uid\(\)[\s\S]+owner_user_id/);
  assert.match(sql, /foreign key \(draft_id, owner_user_id\)[\s\S]+references public\.mara_drafts \(id, owner_user_id\)/);
  for (const fn of [
    "upsert_instagram_publish_queue_item",
    "cancel_instagram_publish_queue_item",
    "claim_due_instagram_publish_jobs",
    "complete_instagram_publish_job",
    "fail_instagram_publish_job",
  ]) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${fn}[\\s\\S]*?from public, anon, authenticated`));
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn}[\\s\\S]*?to service_role`));
  }
  assert.match(sql, /security definer[\s\S]*?set search_path = ''/);
});

test("0022 refuses to reschedule or cancel anything already published or in flight", async () => {
  const sql = await read("supabase/migrations/0022_instagram_auto_publishing.sql");
  assert.match(sql, /if v_row\.status in \('published', 'publishing'\) then\s+return v_row;/);
  assert.match(sql, /status not in \('published', 'publishing'\)/);
});

test("0022 leaves the media bucket private", async () => {
  const sql = await read("supabase/migrations/0022_instagram_auto_publishing.sql");
  assert.match(sql, /update storage\.buckets set public = false where id = 'mara-media'/);
  assert.doesNotMatch(sql, /set public = true/);
});

// ---------------------------------------------------------------------------
// Worker, cron and routes
// ---------------------------------------------------------------------------

test("the cron route is secret-protected and server-only; Supabase Cron schedules it (no Vercel cron entry)", async () => {
  const route = await read("app/api/cron/instagram-publish/route.ts");
  assert.match(route, /process\.env\.CRON_SECRET/);
  assert.match(route, /bearerMatches\(request, secret\)/);
  const bearer = await read("utils/bearer-auth.ts");
  assert.match(bearer, /Bearer \$\{secret\}/, "the shared helper compares the full Bearer header");
  assert.match(bearer, /timingSafeEqual/, "the shared helper compares in constant time");
  assert.match(route, /status: 401/);
  assert.match(route, /runtime = "nodejs"/);
  // Vercel runs on the Hobby plan, which does not support cron schedules:
  // the existing Supabase Cron job (voom-instagram-publish-5m, */5 * * * *)
  // calls this secured endpoint instead, so it must NOT be in vercel.json.
  const vercel = JSON.parse(await read("vercel.json"));
  assert.ok(vercel.crons.every((entry) => entry.path !== "/api/cron/instagram-publish"), "the publishing cron must not be registered in vercel.json");
  assert.ok(vercel.crons.some((entry) => entry.path === "/api/cron/weekly-plans"));
});

test("the worker publishes images and Reels through Meta's real publishing API", async () => {
  const client = await read("lib/instagram/client.ts");
  assert.match(client, /createImageContainer/);
  assert.match(client, /image_url/);
  assert.match(client, /createReelContainer/);
  assert.match(client, /media_type: "REELS"/);
  assert.match(client, /video_url/);
  assert.match(client, /getContainerStatus/);
  assert.match(client, /status_code/);
  assert.match(client, /media_publish/);
  assert.match(client, /creation_id/);

  const worker = await read("lib/instagram/publish-worker.ts");
  assert.match(worker, /createReelContainer/);
  assert.match(worker, /createImageContainer/);
  assert.match(worker, /client\.publishContainer/);
  assert.match(worker, /completePublishItem\(db, item\.id, item\.ownerUserId, instagramMediaId, containerId\)/);
});

test("the worker never publishes without re-validating approval, connection and permission", async () => {
  const flow = await read("lib/instagram/publish-flow.ts");
  assert.match(flow, /draft\.status !== "approved"/);
  assert.match(flow, /connection\.status !== "connected"/);
  assert.match(flow, /hasPublishPermission\(connection\.scopes\)/);
  assert.match(flow, /tokenExpiresAt/);
  const worker = await read("lib/instagram/publish-worker.ts");
  assert.match(worker, /import "server-only"/);
  assert.match(worker, /claimDueItems/);
});

test("an ambiguous publish response never creates a second Instagram post", async () => {
  const flow = await read("lib/instagram/publish-flow.ts");
  // A container recorded by an earlier attempt is reused, never re-created.
  assert.match(flow, /let containerId = item\.containerId;\s*\n\s*if \(!containerId\)/);
  assert.match(flow, /persistContainerId/);
  // On an ambiguous publish, Voom reads the account before ever retrying.
  assert.match(flow, /safeRecover/);
  assert.match(flow, /if \(item\.instagramMediaId\) return \{ outcome: "published", mediaId: item\.instagramMediaId \}/);
  assert.match(flow, /status === "PUBLISHED"/);
  const worker = await read("lib/instagram/publish-worker.ts");
  assert.match(worker, /recordContainerId/);
});

test("private media reaches Meta only through a short-lived, asset-scoped signed URL", async () => {
  const worker = await read("lib/instagram/publish-worker.ts");
  assert.match(worker, /createSignedUrl\(storagePath, PUBLISH_SIGNED_URL_TTL_SECONDS\)/);
  assert.doesNotMatch(worker, /getPublicUrl/);
  assert.doesNotMatch(worker, /public = true/);
});

test("the queue helper is server-only and drives everything through security-definer RPCs", async () => {
  const queue = await read("lib/instagram/publish-queue.ts");
  assert.match(queue, /import "server-only"/);
  for (const fn of [
    "upsert_instagram_publish_queue_item",
    "cancel_instagram_publish_queue_item",
    "claim_due_instagram_publish_jobs",
    "complete_instagram_publish_job",
    "fail_instagram_publish_job",
  ]) {
    assert.match(queue, new RegExp(fn));
  }
});

test("approving with a schedule enqueues, and un-approving or rejecting cancels", async () => {
  const data = await read("lib/post/server-data.ts");
  assert.match(data, /syncPostToPublishQueue/);
  assert.match(data, /enqueuePublishItem/);
  assert.match(data, /cancelPublishItem/);
  const route = await read("app/api/posts/[id]/route.ts");
  assert.match(route, /action === "reject" \|\| action === "cancel"/);
  assert.match(route, /cancelPublishItem\(admin, user\.id, id\)/);
  assert.match(route, /Voom will not publish this to Instagram/);
});

test("the publishing queue API never exposes storage paths or tokens", async () => {
  const route = await read("app/api/instagram/publishing-queue/route.ts");
  assert.match(route, /getCurrentUser/);
  assert.match(route, /status: 401/);
  assert.match(route, /createSignedUrl/);
  assert.doesNotMatch(route, /storage_path:/);
  assert.doesNotMatch(route, /access_token/);
  assert.match(route, /missingPermission/);
});

test("Content Calendar shows thumbnail, type, account, time, status and a safe reason", async () => {
  const ui = await read("components/voom/PublishingQueue.tsx");
  assert.match(ui, /Instagram publishing queue/);
  assert.match(ui, /thumbnailUrl/);
  assert.match(ui, /item\.type/);
  assert.match(ui, /item\.account/);
  assert.match(ui, /formatDateTime\(item\.scheduledAt\)/);
  assert.match(ui, /Voom will auto-publish/);
  assert.match(ui, /item\.failureReason/);
  assert.match(ui, /Needs attention/);
  assert.match(ui, /Instagram publishing permission required/);
  const page = await read("app/app/(shell)/calendar/page.tsx");
  assert.match(page, /<PublishingQueue \/>/);
});

// ---------------------------------------------------------------------------
// The real publish sequence, exercised end to end with fake ports.
// ---------------------------------------------------------------------------

const { runPublishFlow } = await import("../lib/instagram/publish-flow.ts");

function makePorts(overrides = {}) {
  const calls = { containers: [], publishes: [], statuses: 0, published: [], failed: [], signed: [] };
  const ports = {
    calls,
    async loadDraft() { return { status: "approved", content: "Synrapay caption" }; },
    async loadConnection() {
      return { status: "connected", scopes: ["instagram_business_basic", "instagram_business_content_publish"], tokenExpiresAt: null };
    },
    async loadCredentials() { return { igUserId: "178414", accessToken: "TOKEN" }; },
    async loadAsset() { return { storagePath: `${OWNER}/post-assets/abc-${DRAFT}.jpg`, mimeType: "image/jpeg", status: "uploaded" }; },
    async signMediaUrl(path) { calls.signed.push(path); return `https://signed.example/${path}?token=x`; },
    async createContainer(input) { calls.containers.push(input); return `container-${calls.containers.length}`; },
    async containerStatus() { calls.statuses += 1; return "FINISHED"; },
    async publishContainer(input) { calls.publishes.push(input); return "17999999"; },
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

const imageItem = () => ({
  id: "queue-1", ownerUserId: OWNER, draftId: DRAFT, mediaKind: "image",
  caption: "Synrapay caption", attempts: 1, containerId: null, instagramMediaId: null,
});
const reelItem = () => ({ ...imageItem(), mediaKind: "reel" });

test("image Post publishing: container → readiness → media_publish → real media id", async () => {
  const ports = makePorts();
  const item = imageItem();
  const result = await runPublishFlow(item, ports);
  assert.equal(result.outcome, "published");
  assert.equal(result.mediaId, "17999999");
  assert.equal(ports.calls.containers.length, 1);
  assert.equal(ports.calls.containers[0].kind, "image");
  assert.match(ports.calls.containers[0].mediaUrl, /^https:\/\/signed\.example\//);
  assert.equal(ports.calls.publishes.length, 1);
  assert.deepEqual(ports.calls.published, [{ mediaId: "17999999", containerId: "container-1" }]);
  assert.equal(ports.calls.failed.length, 0);
});

test("Reel publishing waits for Meta to finish transcoding before publishing", async () => {
  const sequence = ["IN_PROGRESS", "IN_PROGRESS", "FINISHED"];
  let index = 0;
  const slept = [];
  const ports = makePorts({
    async loadAsset() { return { storagePath: `${OWNER}/post-assets/abc-${DRAFT}.mp4`, mimeType: "video/mp4", status: "uploaded" }; },
    async containerStatus() { return sequence[Math.min(index++, sequence.length - 1)]; },
    async sleep(ms) { slept.push(ms); },
  });
  const result = await runPublishFlow(reelItem(), ports);
  assert.equal(result.outcome, "published");
  assert.equal(ports.calls.containers[0].kind, "reel");
  assert.equal(slept.length, 2, "Voom must poll while the Reel is IN_PROGRESS");
  assert.equal(ports.calls.publishes.length, 1);
});

test("a Reel stuck in processing is retried, never falsely published", async () => {
  const ports = makePorts({
    async loadAsset() { return { storagePath: "p.mp4", mimeType: "video/mp4", status: "uploaded" }; },
    async containerStatus() { return "IN_PROGRESS"; },
  });
  const result = await runPublishFlow(reelItem(), ports);
  assert.equal(result.outcome, "retrying");
  assert.equal(result.code, "container_timeout");
  assert.equal(ports.calls.publishes.length, 0);
  assert.equal(ports.calls.published.length, 0);
  assert.equal(ports.calls.failed[0].status, "scheduled");
  assert.ok(ports.calls.failed[0].retryAt);
});

test("a missing Instagram connection never publishes", async () => {
  const ports = makePorts({ async loadConnection() { return null; } });
  const result = await runPublishFlow(imageItem(), ports);
  assert.equal(result.outcome, "failed");
  assert.equal(result.code, "instagram_not_connected");
  assert.equal(ports.calls.containers.length, 0);
});

test("a missing publish permission never publishes and reports the exact permission", async () => {
  const ports = makePorts({
    async loadConnection() { return { status: "connected", scopes: ["instagram_business_basic"], tokenExpiresAt: null }; },
  });
  const result = await runPublishFlow(imageItem(), ports);
  assert.equal(result.outcome, "failed");
  assert.equal(result.code, "publish_permission_required");
  assert.equal(ports.calls.failed[0].status, "permission_required");
  assert.match(ports.calls.failed[0].message, /instagram_business_content_publish/);
  assert.equal(ports.calls.containers.length, 0);
});

test("a rejected draft is never published even once queued", async () => {
  const ports = makePorts({ async loadDraft() { return { status: "rejected", content: "x" }; } });
  const result = await runPublishFlow(imageItem(), ports);
  assert.equal(result.outcome, "failed");
  assert.equal(result.code, "not_approved");
  assert.equal(ports.calls.containers.length, 0);
});

test("missing media parks the item as waiting_for_media instead of failing loudly", async () => {
  const ports = makePorts({ async loadAsset() { return null; } });
  const result = await runPublishFlow(imageItem(), ports);
  assert.equal(result.outcome, "retrying");
  assert.equal(ports.calls.failed[0].status, "waiting_for_media");
});

test("a container creation failure is recorded as retryable and publishes nothing", async () => {
  const ports = makePorts({ async createContainer() { throw new Error("provider down"); } });
  const result = await runPublishFlow(imageItem(), ports);
  assert.equal(result.outcome, "retrying");
  assert.equal(result.code, "container_failed");
  assert.equal(ports.calls.publishes.length, 0);
});

test("a container that errors while processing is a terminal, truthful failure", async () => {
  const ports = makePorts({ async containerStatus() { return "ERROR"; } });
  const result = await runPublishFlow(imageItem(), ports);
  assert.equal(result.outcome, "failed");
  assert.equal(result.code, "container_error");
  assert.equal(ports.calls.published.length, 0);
});

test("an already-published item is never published twice", async () => {
  const ports = makePorts();
  const item = { ...imageItem(), instagramMediaId: "17999999" };
  const result = await runPublishFlow(item, ports);
  assert.equal(result.outcome, "published");
  assert.equal(ports.calls.containers.length, 0);
  assert.equal(ports.calls.publishes.length, 0);
});

test("a duplicate cron execution over the same item creates exactly one Instagram post", async () => {
  const ports = makePorts();
  const item = imageItem();
  const first = await runPublishFlow(item, ports);
  // Second worker sees the item mutated to its published state (the DB claim
  // makes this impossible in production; this proves the flow is safe anyway).
  const second = await runPublishFlow(item, ports);
  assert.equal(first.outcome, "published");
  assert.equal(second.outcome, "published");
  assert.equal(ports.calls.publishes.length, 1, "media_publish must be called exactly once");
  assert.equal(ports.calls.containers.length, 1);
});

test("retry after a failure reuses the stored container instead of creating a second one", async () => {
  let attempt = 0;
  const ports = makePorts({
    async publishContainer(input) {
      ports.calls.publishes.push(input);
      if (attempt++ === 0) throw new Error("network");
      return "17999999";
    },
  });
  const item = imageItem();
  const first = await runPublishFlow(item, ports);
  assert.equal(first.outcome, "retrying");
  assert.equal(item.containerId, "container-1");

  const second = await runPublishFlow({ ...item, attempts: 2 }, ports);
  assert.equal(second.outcome, "published");
  assert.equal(ports.calls.containers.length, 1, "the container is created once and reused on retry");
});

test("an ambiguous publish response recovers the real media id instead of posting again", async () => {
  const ports = makePorts({
    async publishContainer() { throw new Error("timeout after send"); },
    async findPublishedMediaId() { return "17123456"; },
  });
  const result = await runPublishFlow(imageItem(), ports);
  assert.equal(result.outcome, "published");
  assert.equal(result.mediaId, "17123456");
  assert.deepEqual(ports.calls.published, [{ mediaId: "17123456", containerId: "container-1" }]);
});

test("a container Meta already published is recovered, not republished", async () => {
  const ports = makePorts({
    async containerStatus() { return "PUBLISHED"; },
    async findPublishedMediaId() { return "17555555"; },
  });
  const result = await runPublishFlow(imageItem(), ports);
  assert.equal(result.outcome, "published");
  assert.equal(result.mediaId, "17555555");
  assert.equal(ports.calls.publishes.length, 0);
});

test("an unsupported file type is never sent to Instagram", async () => {
  const ports = makePorts({ async loadAsset() { return { storagePath: "p.webp", mimeType: "image/webp", status: "uploaded" }; } });
  const result = await runPublishFlow(imageItem(), ports);
  assert.equal(result.outcome, "failed");
  assert.equal(result.code, "media_unsupported");
  assert.equal(ports.calls.containers.length, 0);
});

test("an expired token fails safely without calling Instagram", async () => {
  const ports = makePorts({
    async loadConnection() {
      return { status: "connected", scopes: ["instagram_business_content_publish"], tokenExpiresAt: "2026-09-01T00:00:00.000Z" };
    },
  });
  const result = await runPublishFlow(imageItem(), ports);
  assert.equal(result.outcome, "failed");
  assert.equal(result.code, "instagram_token_expired");
  assert.equal(ports.calls.containers.length, 0);
});

test("the exhausted retry budget converts a retryable failure into a truthful failure", async () => {
  const ports = makePorts({ async createContainer() { throw new Error("down"); } });
  const result = await runPublishFlow({ ...imageItem(), attempts: pub.MAX_PUBLISH_ATTEMPTS }, ports);
  assert.equal(result.outcome, "failed");
  assert.equal(ports.calls.failed[0].status, "failed");
  assert.equal(ports.calls.failed[0].retryAt, null);
});

// ---------------------------------------------------------------------------
// Regression: a retried item must actually be reclaimable by a later cron run.
//
// A retry writes a status AND a future scheduled_at. If the claim predicate
// does not cover that status, the item is stranded forever: visible in the UI,
// never published. This suite proves every retryable status round-trips.
// ---------------------------------------------------------------------------

test("every retryable failure lands in a status a later cron run can reclaim", () => {
  // The set of statuses claim_due_instagram_publish_jobs will pick up once
  // scheduled_at is due. Mirrored by isDueForPublishing.
  const reclaimable = ["scheduled", "waiting_for_media"];
  for (const [key, failure] of Object.entries(pub.PUBLISH_FAILURES)) {
    if (!failure.retryable) continue;
    assert.ok(
      reclaimable.includes(failure.status),
      `retryable failure '${key}' parks the item in '${failure.status}', which no cron run would ever reclaim`,
    );
    // And prove it via the real predicate, at its own retry time.
    const at = pub.retryAt(NOW);
    assert.equal(
      pub.isDueForPublishing(
        { status: failure.status, scheduledAt: at, draftStatus: "approved", attempts: 1, instagramMediaId: null },
        Date.parse(at) + 1000,
      ),
      true,
      `'${failure.status}' must be claimable once its retry time is due`,
    );
  }
});

test("a waiting_for_media item is not claimed early, but is claimed once due", () => {
  const at = pub.retryAt(NOW);
  const row = { status: "waiting_for_media", scheduledAt: at, draftStatus: "approved", attempts: 1, instagramMediaId: null };
  assert.equal(pub.isDueForPublishing(row, NOW), false, "not before its retry time");
  assert.equal(pub.isDueForPublishing(row, Date.parse(at) + 1), true, "claimable once due");
  // Still never claimed when it must not be.
  assert.equal(pub.isDueForPublishing({ ...row, draftStatus: "rejected" }, Date.parse(at) + 1), false);
  assert.equal(pub.isDueForPublishing({ ...row, instagramMediaId: "17999" }, Date.parse(at) + 1), false);
});

test("the SQL claim predicate and the TypeScript predicate cover the same statuses", async () => {
  const sql = await read("supabase/migrations/0022_instagram_auto_publishing.sql");
  // Anchor on the function body, not the header comment, which also mentions
  // "for update skip locked".
  const body = sql.slice(sql.indexOf("create or replace function public.claim_due_instagram_publish_jobs"));
  const claim = body.slice(body.indexOf("with due as"), body.indexOf("for update skip locked"));
  assert.ok(claim.length > 0, "the claim predicate must be located");
  for (const status of ["scheduled", "waiting_for_media", "publishing"]) {
    assert.match(claim, new RegExp(`q\\.status = '${status}'`), `claim must consider '${status}'`);
  }
  // The partial index must mirror the predicate or those claims lose the index.
  assert.match(
    sql,
    /instagram_publish_queue_due_idx[\s\S]*?where status in \('scheduled', 'waiting_for_media', 'publishing'\)/,
  );
});

test("a Reel that is still processing is retried and published by a later cron run", async () => {
  // Cron run 1: Meta is still transcoding for the whole poll window.
  const first = makePorts({
    async loadAsset() { return { storagePath: "reel.mp4", mimeType: "video/mp4", status: "uploaded" }; },
    async containerStatus() { return "IN_PROGRESS"; },
  });
  const item = reelItem();
  const run1 = await runPublishFlow(item, first);

  assert.equal(run1.outcome, "retrying");
  assert.equal(run1.code, "container_timeout");
  assert.equal(first.calls.publishes.length, 0, "nothing may be published while processing");
  const parked = first.calls.failed[0];
  assert.ok(parked.retryAt, "a retry time must be persisted");

  // The row as the database now holds it.
  const stored = {
    status: parked.status,
    scheduledAt: parked.retryAt,
    draftStatus: "approved",
    attempts: 2,
    instagramMediaId: null,
  };

  // Cron run 2, before the retry time: not yet claimable.
  assert.equal(pub.isDueForPublishing(stored, NOW), false);

  // Cron run 3, after the retry time: the claim predicate MUST pick it up.
  const later = Date.parse(parked.retryAt) + 60_000;
  assert.equal(pub.isDueForPublishing(stored, later), true, "the retried Reel must be reclaimable");

  // And on that run Meta has finished, so it publishes exactly once.
  const second = makePorts({
    async loadAsset() { return { storagePath: "reel.mp4", mimeType: "video/mp4", status: "uploaded" }; },
    async containerStatus() { return "FINISHED"; },
    now: () => later,
  });
  const run2 = await runPublishFlow({ ...item, attempts: 2 }, second);
  assert.equal(run2.outcome, "published");
  assert.equal(run2.mediaId, "17999999");
  assert.equal(second.calls.publishes.length, 1);
  // Run 1 already persisted the container onto the item, so run 2 creates NO
  // new container — it resumes the existing one. That is what stops a retry
  // from producing a second Instagram post.
  assert.equal(second.calls.containers.length, 0);
  assert.equal(item.containerId, "container-1");
});

test("a post whose visual arrives late is parked, then reclaimed, then published", async () => {
  // Cron run 1: the asset row is not there yet.
  const first = makePorts({ async loadAsset() { return null; } });
  const run1 = await runPublishFlow(imageItem(), first);

  assert.equal(run1.outcome, "retrying");
  const parked = first.calls.failed[0];
  assert.equal(parked.status, "waiting_for_media", "this is the truthful UI status");
  assert.ok(parked.retryAt);

  // This is the exact combination the audit flagged: a non-'scheduled' status
  // carrying a future retry time. It must still be reclaimable.
  const stored = {
    status: parked.status,
    scheduledAt: parked.retryAt,
    draftStatus: "approved",
    attempts: 2,
    instagramMediaId: null,
  };
  const later = Date.parse(parked.retryAt) + 60_000;
  assert.equal(
    pub.isDueForPublishing(stored, later),
    true,
    "a waiting_for_media item must never be stranded once its retry time passes",
  );

  // Cron run 2: the visual now exists and the post publishes.
  const second = makePorts({ now: () => later });
  const run2 = await runPublishFlow({ ...imageItem(), attempts: 2 }, second);
  assert.equal(run2.outcome, "published");
  assert.equal(second.calls.publishes.length, 1);
});

test("the publish worker resolves tokens through the current key ring (PR #15/#16 API)", async () => {
  // The worker runs against the staged key-ring APIs merged via PR #15/#16:
  // credentials decrypt with the PRIMARY -> NEXT -> LEGACY ring built by
  // instagramKeyRing(config), never with a bare key.
  const worker = await read("lib/instagram/publish-worker.ts");
  assert.match(worker, /getInstagramServerCredentials\(db, ownerId, instagramKeyRing\(config\)\)/);
  assert.doesNotMatch(worker, /config\.encryptionKey\b/);
  const data = await read("lib/instagram/data.ts");
  assert.match(data, /getInstagramServerCredentials\(db: SupabaseClient, ownerId: string, encryptionKey: InstagramKeyInput\)/);
});
