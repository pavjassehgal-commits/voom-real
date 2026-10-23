import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const { contentBucket, filterContent, CONTENT_TABS } = await import("../lib/voom/content-library-core.ts");
const { readinessChecks } = await import("../lib/voom/create-readiness.ts");

const item = (overrides = {}) => ({
  id: "a", kind: "instagram_post", channel: "instagram", typeLabel: "Instagram Post", title: "Glow naturally",
  excerpt: "Skincare that works with your skin", hashtags: [], scheduledAt: null, createdAt: "2026-10-01T10:00:00Z",
  updatedAt: "2026-10-20T10:00:00Z", sortAt: "2026-10-20T10:00:00Z", state: "draft", stateLabel: "Draft", bucket: "drafts",
  origin: null, previewUrl: null, mediaName: null, mediaReady: false, failureMessage: null, metrics: null, editor: "post", ...overrides,
});

test("content buckets follow the canonical lifecycle: Published only after provider confirmation", () => {
  assert.equal(contentBucket("published"), "published");
  for (const state of ["scheduled", "submitting", "provider_processing"]) assert.equal(contentBucket(state), "scheduled", state);
  for (const state of ["failed", "blocked", "connection_required"]) assert.equal(contentBucket(state), "attention", state);
  for (const state of ["draft", "needs_approval", "approved"]) assert.equal(contentBucket(state), "drafts", state);
  assert.equal(contentBucket("rejected"), "rejected");
  assert.deepEqual(CONTENT_TABS.map((tab) => tab.id), ["all", "drafts", "scheduled", "published", "attention"]);
  assert.ok(!CONTENT_TABS.some((tab) => /archiv/i.test(tab.label)), "no Archived tab: Voom has no archive state");
});

test("content filters act on real fields only", () => {
  const items = [
    item({ id: "1", title: "Glow naturally", channel: "instagram", bucket: "published", sortAt: "2026-10-20T10:00:00Z" }),
    item({ id: "2", title: "TikTok hook", channel: "tiktok", bucket: "scheduled", sortAt: "2026-10-25T10:00:00Z" }),
    item({ id: "3", title: "Old post", channel: "instagram", bucket: "drafts", sortAt: "2026-08-01T10:00:00Z" }),
  ];
  const now = new Date("2026-10-22T12:00:00Z");
  const base = { tab: "all", channel: "all", period: "all", query: "", sort: "newest", now };
  assert.deepEqual(filterContent(items, base).map((entry) => entry.id), ["2", "1", "3"]);
  assert.deepEqual(filterContent(items, { ...base, sort: "oldest" }).map((entry) => entry.id), ["3", "1", "2"]);
  assert.deepEqual(filterContent(items, { ...base, tab: "published" }).map((entry) => entry.id), ["1"]);
  assert.deepEqual(filterContent(items, { ...base, channel: "tiktok" }).map((entry) => entry.id), ["2"]);
  assert.deepEqual(filterContent(items, { ...base, period: "30" }).map((entry) => entry.id), ["2", "1"]);
  assert.deepEqual(filterContent(items, { ...base, query: "hook" }).map((entry) => entry.id), ["2"]);
});

const draft = (overrides = {}) => ({
  id: "d", editor: "post", kind: "instagram_post", channel: "instagram", typeLabel: "Instagram Post", title: "Glow",
  caption: "Skincare that works.", description: null, hashtags: ["glow"], format: "4:5", previewUrl: null, mimeType: "image/jpeg",
  mediaName: "glow.jpg", mediaReady: true, status: "draft", scheduledAt: null, privacy: null, madeForKids: null, tiktokPrivacy: null, tiktokConsent: false,
  ...overrides,
});

test("Instagram readiness uses the same approval blockers the approve route enforces", () => {
  const ready = readinessChecks(draft());
  assert.ok(ready.every((check) => check.ok), JSON.stringify(ready));
  const noMedia = readinessChecks(draft({ mediaReady: false, mediaName: null }));
  assert.ok(noMedia.some((check) => !check.ok && /Media needed/.test(check.label)));
  assert.ok(noMedia.some((check) => !check.ok && /Not ready to approve/.test(check.label)));
  const story = readinessChecks(draft({ kind: "story", caption: "" }));
  assert.ok(story.some((check) => check.ok && /No caption needed/.test(check.label)), "Stories carry no caption");
  const tooLong = readinessChecks(draft({ caption: "x".repeat(2201) }));
  assert.ok(tooLong.some((check) => !check.ok && /Caption 2,201/.test(check.label)));
});

test("TikTok and YouTube readiness require the platform declarations, never assumed", () => {
  const tiktok = readinessChecks(draft({ editor: "social", channel: "tiktok", kind: "tiktok_video", hashtags: [] }));
  assert.ok(tiktok.some((check) => !check.ok && /Privacy not chosen/.test(check.label)));
  assert.ok(tiktok.some((check) => !check.ok && /Confirmation needed/.test(check.label)));
  const confirmed = readinessChecks(draft({ editor: "social", channel: "tiktok", kind: "tiktok_video", tiktokPrivacy: "SELF_ONLY", tiktokConsent: true }));
  assert.ok(confirmed.every((check) => check.ok));
  const youtube = readinessChecks(draft({ editor: "social", channel: "youtube", kind: "youtube_video", title: "A title" }));
  assert.ok(youtube.some((check) => !check.ok && /Audience not declared/.test(check.label)));
});

test("Create schedule approves through the existing route and hands social posts to the compliant editor", async () => {
  const schedule = await read("components/voom/create/CreateSchedule.tsx");
  assert.match(schedule, /`\/api\/posts\/\$\{draft\.id\}`/);
  assert.match(schedule, /action: "approve"/);
  assert.match(schedule, /contentVersion/, "approval is bound to the saved content version");
  assert.match(schedule, /SocialEditorModal/, "TikTok/YouTube consent stays in the existing publishing editor");
  assert.doesNotMatch(schedule, /Best time|MARA PICK|higher engagement|Publish now/i, "no invented best-time or instant-publish claims");
});

test("Content and Create screens read through existing owner-scoped readers and never write directly", async () => {
  const sources = await Promise.all([
    read("lib/voom/content-library.ts"),
    read("lib/voom/create-draft.ts"),
    read("app/app/(shell)/content/page.tsx"),
    read("app/app/(shell)/content/[id]/page.tsx"),
  ]);
  const all = sources.join("\n");
  assert.match(all, /listPostDrafts/);
  assert.match(all, /listSocialDrafts/);
  assert.match(all, /publishStateFromInstagramQueue/);
  assert.doesNotMatch(all, /\.(insert|update|upsert|delete)\(/, "the library is read-only");
  assert.match(sources[0], /^import "server-only";/m);
  assert.match(sources[1], /^import "server-only";/m);
});

test("Marketing Plan keeps every existing control inside the redesigned Week and List views", async () => {
  const workspace = await read("components/voom/operating/PlanWorkspace.tsx");
  assert.match(workspace, /"week" \| "list"/);
  assert.doesNotMatch(workspace, />Month</, "Month view is a Review design and is not implemented");
  assert.match(workspace, /fetch\("\/api\/plan"/, "build/replenish still uses the existing planner route");
  assert.match(workspace, /<PlanItemCard item=\{selected\}/, "item actions are the existing PlanItemCard");
  assert.doesNotMatch(workspace, /Best time to post|Optimi[sz]e with MARA|% vs last week/, "no invented statistics");
});
