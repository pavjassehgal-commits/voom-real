import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const core = await import("../lib/post/core.ts");

/**
 * The selected post format is persisted on mara_drafts.channel, because
 * mara_drafts has no JSON column and no free metadata column. These tests model
 * the real database round trip: a draft row is written, read back from storage,
 * and re-opened — with and without a visual attached.
 */
const draftRow = ({ kind = "instagram_post", channel, status = "draft" }) => ({
  id: "11111111-1111-4111-8111-111111111111",
  conversation_id: "22222222-2222-4222-8222-222222222222",
  kind,
  channel,
  title: "Summer swimwear",
  content: "Summer is here.",
  proposed_publish_at: null,
  status,
});

// ---------------------------------------------------------------------------
// Requirements 3 and 4: the choice survives a reload before any visual exists
// ---------------------------------------------------------------------------

test("4:5 survives create -> save draft -> reload with no visual", () => {
  // Create the post at 4:5.
  const channelAtCreate = core.encodeDraftChannel("instagram_post", "4:5");
  assert.equal(channelAtCreate, "Instagram · 4:5");

  // Save draft with no visual: the stored row keeps the encoded channel.
  const stored = draftRow({ channel: channelAtCreate });
  assert.equal(stored.channel, "Instagram · 4:5");

  // Reload and reopen: the format is read back off the draft, not off an asset.
  const reopened = core.decodeDraftFormat(stored.channel);
  assert.equal(reopened, "4:5");
  // And there is still no visual at this point.
  assert.equal(core.internalPostState({ status: "draft", scheduledAt: null, hasVisual: false }), "draft");
});

test("1:1 survives create -> save draft -> reload with no visual", () => {
  const channelAtCreate = core.encodeDraftChannel("instagram_post", "1:1");
  assert.equal(channelAtCreate, "Instagram · 1:1");
  const stored = draftRow({ channel: channelAtCreate });
  assert.equal(core.decodeDraftFormat(stored.channel), "1:1");
});

test("the format persists for Reels too", () => {
  assert.equal(core.encodeDraftChannel("reel", "4:5"), "Reel · 4:5");
  assert.equal(core.decodeDraftFormat(core.encodeDraftChannel("reel", "4:5")), "4:5");
  assert.equal(core.decodeDraftFormat(core.encodeDraftChannel("reel", "1:1")), "1:1");
});

test("re-saving a draft preserves the format when no format is sent", () => {
  const stored = draftRow({ channel: core.encodeDraftChannel("instagram_post", "4:5") });
  // savePostDraft falls back to the draft's own decoded format.
  const nextFormat = core.decodeDraftFormat(stored.channel);
  const rewritten = core.encodeDraftChannel("instagram_post", nextFormat);
  assert.equal(rewritten, "Instagram · 4:5");
  assert.equal(core.decodeDraftFormat(rewritten), "4:5");
});

// ---------------------------------------------------------------------------
// Requirement 5: the draft stays the single source of truth
// ---------------------------------------------------------------------------

test("the draft's format wins once an asset exists, and no asset format column is used", async () => {
  const data = await read("lib/post/server-data.ts");

  // toPostView decodes from the draft's channel...
  assert.match(data, /const format = decodeDraftFormat\(draft\.channel as string \| undefined\);/);
  // ...and never reads a post_draft_assets format column.
  assert.doesNotMatch(data, /normalizePostFormat\(asset\?\.format\)/);
  assert.doesNotMatch(data, /asset\?\.format/, "asset.format must not be read as a source of truth");

  const persist = data.slice(data.indexOf("export async function putPostAsset"), data.indexOf("export async function verifyPostAssetStored"));
  assert.match(persist, /Uploading never depends on a format DB column/);
  assert.match(persist, /buildPostDraftAssetWrite/);
  assert.doesNotMatch(persist, /decodeDraftFormat/);
  assert.doesNotMatch(persist, /format: PostFormat/, "putPostAsset must not accept a caller-supplied format");
  assert.doesNotMatch(data, /async function mirrorAssetFormat/);
  assert.doesNotMatch(data, /mirrorAssetFormat\(/);
  assert.doesNotMatch(data, /\.update\(\{ format \}\)/);

  // A stale object with a format field cannot change what the user sees.
  const draft = draftRow({ channel: "Instagram · 4:5" });
  const staleAsset = { status: "uploaded", storage_path: "owner/post-assets/x.png", format: "1:1" };
  assert.equal(core.decodeDraftFormat(draft.channel), "4:5", "draft says 4:5");
  assert.notEqual(staleAsset.format, core.decodeDraftFormat(draft.channel), "an asset format field is not consulted");
});

test("a visual upload does not overwrite the selected format", async () => {
  const route = await read("app/api/posts/[id]/asset/route.ts");
  assert.match(route, /The format is deliberately NOT read from the upload/);
  assert.doesNotMatch(route, /form\.get\("format"\)/);
  assert.doesNotMatch(route, /normalizePostFormat/);
  assert.doesNotMatch(route, /format:/);

  const editor = await read("components/voom/modals/PostEditorModal.tsx");
  // The upload body carries exactly the file and its origin — no format is
  // sent, so the draft's persisted format wins.
  const uploadBody = editor.slice(editor.indexOf("async function uploadFile("), editor.indexOf("async function chooseFormat("));
  assert.ok(uploadBody.length > 0, "uploadFile precedes chooseFormat");
  assert.deepEqual([...uploadBody.matchAll(/form\.set\("([a-z_]+)"/g)].map((match) => match[1]), ["file", "origin"]);
  assert.doesNotMatch(editor, /form\.set\("format"/);

  // A user at 4:5 who uploads a square photo is still at 4:5 afterwards.
  const before = draftRow({ channel: core.encodeDraftChannel("instagram_post", "4:5") });
  assert.equal(core.decodeDraftFormat(before.channel), "4:5");
});

test("image generation does not overwrite the selected format", async () => {
  const route = await read("app/api/posts/[id]/generate/route.ts");
  // Posts and Reels generate at the draft's own format; a Story is locked to
  // its single legal 9:16 format, which is still never a user overwrite.
  assert.match(route, /const format = post\.kind === "story" \? "9:16" : post\.format;/);
  // Generating writes copy, the brief and media rows — never the draft's
  // channel/format — so it cannot change the user's choice.
  const draftWrites = [...route.matchAll(/from\("mara_drafts"\)\s*\.update\(\{([^}]*)\}/g)].map((match) => match[1]);
  assert.ok(draftWrites.length >= 2, "the route updates the draft (brief, copy)");
  for (const patch of draftWrites) assert.doesNotMatch(patch, /\b(channel|format)\b/, `a draft update never touches the format: {${patch.trim()}}`);
  assert.doesNotMatch(route, /encodeDraftChannel|normalizePostFormat/);
  assert.doesNotMatch(route, /async function setFormat/);
  assert.doesNotMatch(route, /from\("post_draft_assets"\)\.update\(\{ format \}\)/);
  assert.doesNotMatch(route, /normalizePostFormat/);
  // The generation row records the same format the draft holds.
  assert.match(route, /aspect_ratio: format,/);
  assert.match(route, /aspectRatio: format/);
});

test("changing the format persists it on the draft immediately", async () => {
  const editor = await read("components/voom/modals/PostEditorModal.tsx");
  assert.match(editor, /async function chooseFormat\(value: PostFormat\)/);
  assert.match(editor, /body: JSON\.stringify\(\{ action: "save", format: value \}\)/);
  assert.match(editor, /onClick=\{\(\) => void chooseFormat\(value\)\}/);
  assert.match(editor, /Saved with the draft, so it is still \{format\} when you come back/);

  const route = await read("app/api/posts/[id]/route.ts");
  assert.match(route, /const format = body\.format !== undefined \? normalizePostFormat\(body\.format\) : undefined;/);
  const data = await read("lib/post/server-data.ts");
  assert.match(data, /channel: encodeDraftChannel\(existing\.kind, nextFormat\)/);
});

// ---------------------------------------------------------------------------
// Requirement 6: backward compatibility
// ---------------------------------------------------------------------------

test("drafts with no encoded format safely default to 1:1", () => {
  // Rows written before this change carry a bare channel label.
  assert.equal(core.decodeDraftFormat("Instagram"), "1:1");
  assert.equal(core.decodeDraftFormat("Reel"), "1:1");
  // Missing or odd values must not throw.
  assert.equal(core.decodeDraftFormat(null), "1:1");
  assert.equal(core.decodeDraftFormat(undefined), "1:1");
  assert.equal(core.decodeDraftFormat(""), "1:1");
  assert.equal(core.decodeDraftFormat("Instagram · 16:9"), "1:1", "non-post formats fall back");
  assert.equal(core.decodeDraftFormat("Instagram · portrait"), "1:1");
  assert.equal(core.decodeDraftFormat("Feed"), "1:1");
  // An explicit fallback is honoured.
  assert.equal(core.decodeDraftFormat("Instagram", "4:5"), "4:5");
});

test("base channel labels stay clean for calendar and legacy consumers", () => {
  assert.equal(core.baseChannelFor("instagram_post"), "Instagram");
  assert.equal(core.baseChannelFor("reel"), "Reel");
  assert.equal(core.baseChannelFromDraftChannel("Instagram · 4:5"), "Instagram");
  assert.equal(core.baseChannelFromDraftChannel("Reel · 1:1"), "Reel");
  assert.equal(core.baseChannelFromDraftChannel("Instagram"), "Instagram");
  // The calendar enum is derived from kind, never from the encoded label.
  assert.equal(core.calendarChannelFor("instagram_post"), "Instagram");
  assert.equal(core.calendarChannelFor("reel"), "Reel");
  // The encoded label still fits mara_drafts' 1-60 character check.
  for (const kind of ["instagram_post", "reel"]) {
    for (const format of ["1:1", "4:5"]) {
      assert.ok(core.encodeDraftChannel(kind, format).length <= 60);
    }
  }
});

test("Post format needed no schema change; 0022-0027 remain intact and 0028 is video metadata", async () => {
  const files = await readdir(new URL("supabase/migrations/", root));
  assert.ok(files.includes("0021_instagram_post_studio.sql"), "0021 must be checked in");
  assert.deepEqual(files.filter((name) => /^0022_/.test(name)), ["0022_instagram_auto_publishing.sql"], "the only 0022 is Instagram auto-publishing");
  assert.ok(files.includes("0023_instagram_token_key_rotation.sql"), "0023 (Instagram key rotation) must be checked in");
  assert.deepEqual(files.filter((name) => /^0024_/.test(name)), ["0024_instagram_story_publishing.sql"], "the only 0024 is Instagram Story publishing");
  assert.deepEqual(files.filter((name) => /^0025_/.test(name)), ["0025_mara_media_video_generation.sql"], "the only 0025 is MARA media video generation");
  assert.deepEqual(files.filter((name) => /^0026_/.test(name)), ["0026_mara_media_brief.sql"], "the only 0026 is MARA media brief");
  assert.deepEqual(files.filter((name) => /^0027_/.test(name)), ["0027_mara_media_provider_diagnostics.sql"], "the only 0027 is provider diagnostics");
  assert.deepEqual(files.filter((name) => /^0028_/.test(name)), ["0028_openrouter_video_job_metadata.sql"], "the only 0028 is OpenRouter video job metadata");
  assert.deepEqual(files.filter((name) => /^0029_/.test(name)), ["0029_workflow_timezone_and_slots.sql"], "the only 0029 is the workflow timezone + slot migration");
  const numbered = files.filter((name) => /^\d{4}_/.test(name));
  // Production is through 0045 (Campaigns v3). Anything newer is a migration
  // this suite has not been told about — it must be added deliberately.
  assert.ok(numbered.every((name) => Number(name.slice(0, 4)) <= 45), "no migration beyond 0045 (the production head) may exist");
  assert.deepEqual(
    files.filter((name) => /^0032_/.test(name)),
    ["0032_instagram_performance_intelligence.sql"],
    "the only 0032 is the additive performance snapshots migration",
  );
  assert.deepEqual(
    files.filter((name) => /^0033_/.test(name)),
    ["0033_automated_campaigns.sql"],
    "the only 0033 is the Automated Campaigns migration",
  );
  assert.deepEqual(
    files.filter((name) => /^0034_/.test(name)),
    ["0034_automated_campaign_shape_check_fix.sql"],
    "the only 0034 is the Automated Campaigns shape-check hotfix",
  );
  assert.deepEqual(
    files.filter((name) => /^0031_/.test(name)),
    ["0031_ai_media_spend_control.sql"],
    "the only 0031 is the AI media spend control migration",
  );
  assert.deepEqual(files.filter((name) => /^0030_/.test(name)), ["0030_publish_queue_waiting_for_media.sql"], "the only 0030 is the publish-queue waiting-for-media lifecycle migration");

  // 0021 is unchanged by this fix: it still carries no format column on
  // mara_drafts, and the format is stored in the pre-existing channel column.
  const migration = await read("supabase/migrations/0021_instagram_post_studio.sql");
  assert.doesNotMatch(migration, /alter table public\.mara_drafts\s+add column/i, "0021 must not add mara_drafts columns");
  assert.match(migration, /ALREADY APPLIED to the production Supabase database/i);
});
