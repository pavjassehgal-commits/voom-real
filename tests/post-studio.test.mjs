import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

/** Strips `--` line comments so structural guards test executable SQL only. */
const sqlStatements = (sql) => sql.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");

const core = await import("../lib/post/core.ts");
const prompt = await import("../lib/post/prompt.ts");

// ---------------------------------------------------------------------------
// instagram_post kind, formats, and the draft-kind contract
// ---------------------------------------------------------------------------

test("Post Studio writes the instagram_post draft kind and accepts both V1 formats plus the Story format", () => {
  assert.equal(core.POST_DRAFT_KIND, "instagram_post");
  assert.equal(core.REEL_DRAFT_KIND, "reel");
  assert.equal(core.STORY_DRAFT_KIND, "story");
  assert.deepEqual([...core.POST_FORMATS], ["1:1", "4:5", "9:16"]);
  assert.equal(core.isPostFormat("1:1"), true);
  assert.equal(core.isPostFormat("4:5"), true);
  assert.equal(core.isPostFormat("9:16"), true, "9:16 is the Instagram Story format");
  assert.equal(core.normalizePostFormat("4:5"), "4:5");
  assert.equal(core.normalizePostFormat("16:9"), "1:1", "unknown formats fall back safely");
  assert.equal(core.formatAspectRatio("1:1"), "1 / 1");
  assert.equal(core.formatAspectRatio("4:5"), "4 / 5");
  assert.equal(core.formatAspectRatio("9:16"), "9 / 16");
  assert.equal(core.isPostDraftKind("instagram_post"), true);
  assert.equal(core.isPostDraftKind("story"), true);
  assert.equal(core.isPostDraftKind("instagram_caption"), false);
});

test("migration 0021 adds instagram_post to the mara_drafts kind check", async () => {
  const sql = await read("supabase/migrations/0021_instagram_post_studio.sql");
  assert.match(sql, /add constraint mara_drafts_kind_check/);
  assert.match(sql, /'instagram_post'/);
  // Every previously valid kind must survive.
  for (const kind of ["instagram_caption", "reel", "email", "sms", "campaign_plan", "weekly_calendar"]) {
    assert.match(sql, new RegExp(`'${kind}'`), `0021 must keep ${kind} valid`);
  }
});

// ---------------------------------------------------------------------------
// Caption / CTA / hashtag round trip
// ---------------------------------------------------------------------------

test("captions compose and split back into caption, CTA and hashtags", () => {
  const composed = core.composePostCaption({ caption: "Summer is here.", cta: "Find your summer fit", hashtags: ["summerfit", "familyoutfit"] });
  assert.match(composed, /^Summer is here\.\n\nCTA: Find your summer fit\n\n#summerfit #familyoutfit$/);
  assert.deepEqual(core.splitPostCaption(composed), {
    caption: "Summer is here.", cta: "Find your summer fit", hashtags: ["summerfit", "familyoutfit"],
  });
});

test("splitting tolerates hand-written captions with no CTA or hashtags", () => {
  assert.deepEqual(core.splitPostCaption("Just a plain caption\nwith two lines"), { caption: "Just a plain caption\nwith two lines", cta: "", hashtags: [] });
  assert.deepEqual(core.splitPostCaption("Caption\n\nCTA: Book now"), { caption: "Caption", cta: "Book now", hashtags: [] });
});

test("hashtags are cleaned, de-duplicated and capped at twenty", () => {
  // "#Summer Fit" has no legal space, so it becomes one tag that then
  // de-duplicates against the explicit "summerfit".
  assert.deepEqual(core.normalizeHashtags("#Summer Fit, #summerfit, !!, #a".split(",")), ["SummerFit", "a"]);
  assert.deepEqual(core.normalizeHashtags("one two"), ["one", "two"]);
  assert.equal(core.normalizeHashtags(Array.from({ length: 40 }, (_, i) => `tag${i}`)).length, 20);
  assert.equal(core.normalizeHashtags(["averyveryverylonghashtagthatgoesonandonandon"]).length, 1);
  assert.ok(core.normalizeHashtags(["averyveryverylonghashtagthatgoesonandonandon"])[0].length <= 30);
  assert.equal(core.formatHashtags(["a", "b"]), "#a #b");
});

// ---------------------------------------------------------------------------
// Truthful internal states, approval and scheduling
// ---------------------------------------------------------------------------

test("internal states are Draft, Approved, Scheduled internally and Ready to publish — never Posted", () => {
  assert.deepEqual(
    [...core.POST_INTERNAL_STATES],
    ["draft", "approved", "scheduled_internal", "ready_to_publish"],
  );
  assert.deepEqual(core.POST_STATE_LABELS, {
    draft: "Draft", approved: "Approved", scheduled_internal: "Scheduled internally", ready_to_publish: "Ready to publish",
  });
  assert.ok(!Object.values(core.POST_STATE_LABELS).some((label) => /posted/i.test(label)), "no state may read Posted");

  const scheduled = "2026-09-20T09:00:00.000Z";
  assert.equal(core.internalPostState({ status: "draft", scheduledAt: scheduled, hasVisual: true }), "draft");
  assert.equal(core.internalPostState({ status: "rejected", scheduledAt: null, hasVisual: true }), "draft");
  assert.equal(core.internalPostState({ status: "approved", scheduledAt: null, hasVisual: true }), "approved");
  assert.equal(core.internalPostState({ status: "approved", scheduledAt: scheduled, hasVisual: false }), "scheduled_internal");
  assert.equal(core.internalPostState({ status: "approved", scheduledAt: scheduled, hasVisual: true }), "ready_to_publish");
});

test("only approved content reaches the calendar, with the existing status enum", () => {
  assert.equal(core.appearsOnCalendar("draft"), false);
  assert.equal(core.appearsOnCalendar("approved"), true);
  assert.equal(core.appearsOnCalendar("scheduled_internal"), true);
  assert.equal(core.appearsOnCalendar("ready_to_publish"), true);
  assert.equal(core.calendarStatusFor("approved"), "approved");
  assert.equal(core.calendarStatusFor("scheduled_internal"), "scheduled");
  assert.equal(core.calendarStatusFor("ready_to_publish"), "scheduled");
});

test("approval is blocked until there is a caption and a stored visual", () => {
  assert.deepEqual(core.postApprovalBlockers({ caption: "", hasVisual: false }).length, 2);
  assert.deepEqual(core.postApprovalBlockers({ caption: "Caption", hasVisual: false }), ["Add a visual before approving. Instagram posts and Reels need one."]);
  assert.deepEqual(core.postApprovalBlockers({ caption: "  ", hasVisual: true }), ["Add a caption before approving."]);
  assert.deepEqual(core.postApprovalBlockers({ caption: "Caption", hasVisual: true }), []);
});

test("schedules normalise to ISO strings and only future slots count as scheduled", () => {
  assert.equal(core.normalizeSchedule(null), null);
  assert.equal(core.normalizeSchedule(""), null);
  assert.equal(core.normalizeSchedule("not a date"), null);
  assert.equal(core.normalizeSchedule("2026-09-20T09:00:00Z"), "2026-09-20T09:00:00.000Z");
  const future = new Date(Date.now() + 86_400_000).toISOString();
  assert.equal(core.isFutureSchedule(future), true);
  assert.equal(core.isFutureSchedule("2020-01-01T00:00:00.000Z"), false);
  assert.equal(core.isFutureSchedule(null), false);
});

// ---------------------------------------------------------------------------
// Content type distinctions
// ---------------------------------------------------------------------------

test("content types distinguish Instagram Post, Reel and Existing content", () => {
  assert.equal(core.postTypeLabel("instagram_post", null), "Instagram Post");
  assert.equal(core.postTypeLabel("instagram_post", "uploaded_asset"), "Instagram Post");
  assert.equal(core.postTypeLabel("instagram_post", "mara_generated"), "Instagram Post");
  assert.equal(core.postTypeLabel("instagram_post", "uploaded_existing"), "Existing content");
  assert.equal(core.postTypeLabel("instagram_post", "existing_content"), "Existing content");
  assert.equal(core.postTypeLabel("reel", null), "Reel");
  assert.equal(core.postTypeLabel("reel", "uploaded_asset"), "Reel");
  assert.equal(core.postTypeLabel("reel", "uploaded_existing"), "Existing content");
  assert.equal(core.calendarChannelFor("instagram_post"), "Instagram");
  assert.equal(core.calendarChannelFor("reel"), "Reel");
});

test("an Instagram Post takes images only; a Reel takes images or video", () => {
  assert.deepEqual(core.allowedAssetKindsFor("instagram_post"), ["image"]);
  assert.deepEqual(core.allowedAssetKindsFor("reel"), ["image", "video"]);
  assert.equal(core.postAssetKindForMime("image/jpeg"), "image");
  assert.equal(core.postAssetKindForMime("image/png"), "image");
  assert.equal(core.postAssetKindForMime("image/webp"), "image");
  assert.equal(core.postAssetKindForMime("video/mp4"), "video");
  assert.equal(core.postAssetKindForMime("video/quicktime"), "video");
  assert.equal(core.postAssetKindForMime("application/pdf"), null);
  assert.equal(core.assetOriginFor("mara"), "uploaded_asset");
  assert.equal(core.assetOriginFor("own_asset"), "uploaded_asset");
  assert.equal(core.assetOriginFor("existing_content"), "uploaded_existing");
  assert.equal(core.assetOriginFor("own_asset", "reel"), "uploaded_existing");
  assert.equal(core.assetOriginFor("mara", "instagram_post"), "uploaded_asset");
});

// ---------------------------------------------------------------------------
// MARA prompting stays text-only and honest
// ---------------------------------------------------------------------------

test("MARA's post prompt asks for concept, caption, CTA, hashtags and a visual prompt", () => {
  const parsed = prompt.postDraftSchema.parse({
    concept: "Summer swimwear", caption: "Summer is here for the whole family.", cta: "Find your summer fit",
    hashtags: ["summerfit"], visualPrompt: "A bright flat lay of family swimwear on sand.",
  });
  assert.equal(parsed.concept, "Summer swimwear");
  assert.match(prompt.POST_COPY_SYSTEM_PROMPT, /"visualPrompt":"string"/);
  assert.match(prompt.POST_COPY_SYSTEM_PROMPT, /Never claim the post was published/);
  assert.match(prompt.POST_COPY_SYSTEM_PROMPT, /Never invent prices, discounts, offers/);
});

test("existing-content suggestions never claim MARA saw the visual", async () => {
  const payload = prompt.buildExistingContentPayload({
    displayName: "beach-day.mp4", mimeType: "video/mp4", byteSize: 4_000_000, assetKind: "video",
    brand: { brandName: "Decathlon", brandDescription: "", industry: "", targetCustomer: "", mainGoal: "", brandPersonality: "", contentFrequency: "" },
    plan: null, nowIso: "2026-09-05T09:00:00.000Z",
  });
  assert.equal(payload.maraHasSeenTheFile, false);
  assert.deepEqual(Object.keys(payload.importedFile).sort(), ["mimeType", "name", "sizeBytes", "type"]);
  assert.match(payload.note, /MARA cannot see this file/);
  assert.match(prompt.POST_SUGGESTION_SYSTEM_PROMPT, /You have NOT seen the photo or video/);
  assert.match(prompt.POST_SUGGESTION_SYSTEM_PROMPT, /Do NOT claim you analysed, inspected, viewed, or understood the visual/);
  assert.match(prompt.EXISTING_CONTENT_DISCLOSURE, /MARA has not seen this file/);

  const suggestion = prompt.postSuggestionSchema.parse({
    caption: "Sun, sand and time together.", cta: "Plan your next beach day", hashtags: ["beachday"],
    suggestedPublishAt: "2026-09-20T18:00:00+04:00", timingReason: "Your audience engages in the evening.",
  });
  assert.equal(suggestion.cta, "Plan your next beach day");
});

test("post context payloads carry brand and plan context but never media bytes", () => {
  const payload = prompt.buildPostContextPayload({
    brand: { brandName: "Decathlon", brandDescription: "Sport for all", industry: "Retail", targetCustomer: "Families", mainGoal: "Footfall", brandPersonality: "Practical", contentFrequency: "3x weekly" },
    plan: { businessGoal: "More footfall", weeklyStrategy: "Lead with family summer.", topics: ["Swimwear", "Running"], validUntil: "2026-09-30" },
    format: "4:5", kind: "instagram_post", brief: "Summer swimwear",
  });
  assert.equal(payload.business.name, "Decathlon");
  assert.equal(payload.marketingPlan?.businessGoal, "More footfall");
  assert.deepEqual(payload.marketingPlan?.recentTopics, ["Swimwear", "Running"]);
  assert.equal(payload.requestedFormat, "4:5");
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /bytes|base64|dataUrl|Uint8Array/i, "no media bytes may reach the provider");
});

// ---------------------------------------------------------------------------
// Migration 0021: corrected DROP POLICY syntax, RLS, grants
// ---------------------------------------------------------------------------

test("migration 0021 uses the corrected DROP POLICY syntax, never `on table`", async () => {
  const sql = await read("supabase/migrations/0021_instagram_post_studio.sql");
  // The corrected form.
  assert.match(sql, /drop policy if exists "post_draft_assets_select_own"\s+on public\.post_draft_assets;/);
  assert.match(sql, /create policy "post_draft_assets_select_own"\s+on public\.post_draft_assets\s+for select\s+to authenticated\s+using \(\(select auth\.uid\(\)\) = owner_user_id\);/);
  // The invalid form must not appear in the executable statements. (The header
  // comment deliberately describes it, which is why comments are stripped.)
  const statements = sqlStatements(sql);
  assert.doesNotMatch(statements, /drop policy[^;]*\bon table\b/i, "`drop policy ... on table ...` is a syntax error");
  assert.doesNotMatch(statements, /create policy[^;]*\bon table\b/i);
});

test("post_draft_assets is owner-scoped, service-written, and hides storage_path", async () => {
  const sql = await read("supabase/migrations/0021_instagram_post_studio.sql");
  assert.match(sql, /^begin;/m);
  assert.match(sql, /^commit;/m);
  assert.match(sql, /create table if not exists public\.post_draft_assets/);
  assert.match(sql, /alter table public\.post_draft_assets enable row level security/);
  assert.match(sql, /revoke all on table public\.post_draft_assets from public, anon, authenticated/);
  assert.match(sql, /grant select, insert, update, delete on table public\.post_draft_assets to service_role/);
  assert.match(sql, /foreign key \(draft_id, owner_user_id\)\s+references public\.mara_drafts \(id, owner_user_id\) on delete cascade/);
  assert.match(sql, /unique \(owner_user_id, draft_id\)/);
  assert.match(sql, /unique \(owner_user_id, storage_path\)/);
  assert.doesNotMatch(sql, /format text not null/);
  assert.doesNotMatch(sql, /check \(format in \('1:1','4:5'\)\)/);
  assert.match(sql, /check \(origin in \('uploaded_asset','uploaded_existing'\)\)/);

  // The authenticated grant is metadata-only and must exclude storage_path.
  const grant = sql.match(/grant select \(([\s\S]+?)\) on table public\.post_draft_assets to authenticated/);
  assert.ok(grant, "authenticated must have an explicit column list");
  assert.doesNotMatch(grant[1], /storage_path/, "storage_path must never be granted to authenticated");
  assert.doesNotMatch(grant[1], /\bformat\b/, "format is not a production column");
  for (const column of ["id", "draft_id", "display_name", "mime_type", "byte_size", "origin", "status"]) {
    assert.match(grant[1], new RegExp(column), `${column} should be readable by the owner`);
  }
  assert.doesNotMatch(sql, /grant (insert|update|delete)[^;]+to authenticated/i);
  assert.match(sql, /update storage\.buckets set public = false where id = 'mara-media'/);
});

test("0021 is marked already-applied; 0018-0020 are untouched and 0022-0028 stay scoped", async () => {
  const sql = await read("supabase/migrations/0021_instagram_post_studio.sql");
  assert.match(sql, /ALREADY APPLIED to the production Supabase database/i);
  assert.match(sql, /Do NOT run this file again/i);
  assert.match(sql, /NO 0022 migration/i); // 0021 itself still says Post Studio needs none.
  assert.match(sql, /Migrations 0018, 0019 and 0020 are untouched/i);
  // 0021 must not rewrite the earlier audience/campaign schema, and must not
  // drop anything. Checked against executable statements so the documented
  // rollback steps in the header comment are not mistaken for live DDL.
  const statements = sqlStatements(sql);
  assert.doesNotMatch(statements, /alter table public\.(contacts|audiences|audience_members|voom_campaigns|campaign_recipients|campaign_sends|campaign_delivery_events)/i);
  assert.doesNotMatch(statements, /\bdrop table\b/i);
  assert.doesNotMatch(statements, /\bdrop trigger\b(?! if exists set_post_draft_assets_updated_at)/i);

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
  // Production is through 0045 (Campaigns v3). 0046 (Multi-Social Core), 0047 (YouTube),
  // 0048 (YouTube OAuth ACL) and 0049 (TikTok provider) are checked in but
  // deliberately NOT applied to production yet. Anything newer is a migration
  // this suite has not been told about — it must be added deliberately.
  assert.ok(numbered.every((name) => Number(name.slice(0, 4)) <= 49), "no migration beyond 0049 (the TikTok provider) may exist");
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
});

// ---------------------------------------------------------------------------
// Generated images: persisted privately, Ready only after Voom owns the bytes
// ---------------------------------------------------------------------------

test("Create with MARA generates through the media abstraction and stores bytes before Ready", async () => {
  const route = await read("app/api/posts/[id]/generate/route.ts");
  assert.match(route, /getCurrentUser\(\)/);
  assert.match(route, /createAiProvider\(\)\.structured/);
  assert.match(route, /postDraftSchema\.parse/);
  // Uses the existing provider abstraction rather than a bespoke call.
  assert.match(route, /getMediaConfig\(\)/);
  assert.match(route, /createMediaProvider\(config\)\.generateImage/);
  assert.match(route, /loadPostBrandContext/);
  assert.match(route, /loadPostPlanContext/);
  // Bytes are stored first; the draft row is what makes the visual Ready.
  // Proven on code order, not on a comment: the provider result is inspected,
  // then stored through putPostAsset, and only then is the generation row
  // completed and the calendar synced — a failure before the store leaves no
  // visual attached.
  assert.match(route, /putPostAsset\(admin, user\.id, id/);
  const generateAt = route.indexOf("createMediaProvider(config).generateImage(");
  const inspectAt = route.indexOf("inspectImageBytes(result.bytes)");
  const storeAt = route.indexOf("await putPostAsset(admin, user.id, id, {");
  const completedAt = route.indexOf('status: "completed"');
  const syncAt = route.indexOf("await syncPostToCalendar(admin, user.id, id)");
  assert.ok(generateAt > -1 && inspectAt > generateAt && storeAt > inspectAt && completedAt > storeAt && syncAt > completedAt,
    "generate -> inspect -> store bytes -> mark completed -> sync: the visual is stored BEFORE the post may show it");
  assert.doesNotMatch(route, /instagram\.com|graph\.instagram|media_publish/i);
  assert.doesNotMatch(route, /NEXT_PUBLIC_[A-Z_]*(API_KEY|SECRET)/);
});

test("a post only shows a visual once a stored object exists", async () => {
  const data = await read("lib/post/server-data.ts");
  assert.match(data, /const hasVisual = asset\?\.status === "uploaded" && typeof asset\.storage_path === "string"/);
  assert.match(data, /visualReady: hasVisual/);
  // putPostAsset uploads first and only then writes the row.
  const body = data.slice(data.indexOf("export async function putPostAsset"));
  const uploadAt = body.indexOf(".upload(storagePath, input.bytes");
  const upsertAt = body.indexOf("onConflict: \"owner_user_id,draft_id\"");
  assert.ok(uploadAt > -1 && upsertAt > -1 && uploadAt < upsertAt, "storage upload must precede the metadata row");
  // A failed link must not orphan the object.
  assert.match(body, /await admin\.storage\.from\(POST_ASSET_BUCKET\)\.remove\(\[storagePath\]\)/);
  assert.match(body, /throw new Error\("post_asset_upload_failed"\)/);
  // Generation failures leave no visual attached.
  const route = await read("app/api/posts/[id]/generate/route.ts");
  assert.match(route, /status: "failed", error_code: code/);
  assert.match(route, /No visual was attached/);
});

// ---------------------------------------------------------------------------
// Own asset and existing content ingestion
// ---------------------------------------------------------------------------

test("own-asset uploads are private, owner-isolated and preserved unchanged", async () => {
  const route = await read("app/api/posts/[id]/asset/route.ts");
  assert.match(route, /getCurrentUser\(\)/);
  assert.match(route, /getPostDraft\(admin, user\.id, id\)/);
  assert.match(route, /detectPostAsset\(bytes, file\.name\)/, "magic bytes plus the filename, never the browser content type");
  assert.match(route, /POST_ASSET_MAX_BYTES/);
  assert.match(route, /putPostAsset\(admin, user\.id, id/);
  // No provider is imported: an upload never triggers generation.
  assert.doesNotMatch(route, /@\/lib\/media"|createMediaProvider|getMediaConfig|createAiProvider|@\/lib\/ai/);
  assert.doesNotMatch(route, /instagram\.com|graph\.instagram|media_publish/i);

  const data = await read("lib/post/server-data.ts");
  assert.match(data, /export const POST_ASSET_BUCKET = "mara-media"/);
  assert.match(data, /createSignedUrl\(String\(asset!\.storage_path\), POST_ASSET_SIGNED_TTL_SECONDS\)/);
  assert.match(data, /POST_ASSET_SIGNED_TTL_SECONDS = 600/);
  // Owner-prefixed, unpredictable paths.
  assert.match(data, /const storagePath = `\$\{ownerId\}\/post-assets\//);
});

test("replacing a visual never deletes the object it just wrote", async () => {
  const data = await read("lib/post/server-data.ts");
  // Identical bytes resolve to the same digest path, so the upload must be a
  // no-op rather than a failure.
  assert.match(data, /upsert: true \}\);/);
  assert.match(data, /re-uploading\n *\/\/ the identical file resolves to the same object/);
  assert.match(data, /Promise<\{ storagePath: string; previousStoragePath: string \| null \}>/);
  // Every caller compares paths before deleting, and deletion is guarded so a
  // paid-generation audit row never points at a removed object.
  assert.match(data, /export async function removePostAssetObject/);
  assert.match(data, /\.eq\("storage_path", storagePath\)/);
  assert.match(data, /if \(\(count \?\? 0\) > 0\) return;/);
  for (const path of ["app/api/posts/[id]/asset/route.ts", "app/api/posts/[id]/generate/route.ts"]) {
    const route = await read(path);
    assert.match(route, /previousStoragePath !== storagePath/, `${path} must not delete the current object`);
    assert.match(route, /removePostAssetObject\(admin, user\.id/);
    assert.doesNotMatch(route, /storage\.from\(POST_ASSET_BUCKET\)\.remove/);
    assert.doesNotMatch(route, /storage\.from\("mara-media"\)\.remove/);
  }
});

test("existing image becomes an Instagram Post and existing video becomes a Reel", async () => {
  const route = await read("app/api/posts/[id]/asset/route.ts");
  assert.match(route, /allowedAssetKindsFor\(post\.kind\)/);
  assert.match(route, /const rawOrigin = form\.get\("origin"\)/);
  assert.match(route, /origin: PostOrigin = rawOrigin === "existing_content" \|\| post\.kind === "reel" \? "existing_content" : "own_asset"/);
  const list = await read("app/api/posts/route.ts");
  // Multi-Social Core: the ONE Studio endpoint accepts the Instagram kinds
  // plus the TikTok/YouTube planning kinds.
  assert.match(list, /kind: z\.enum\(\["instagram_post", "reel", "story", "tiktok_video", "youtube_short", "youtube_video"\]\)/);
  assert.match(list, /origin: z\.enum\(POST_ORIGINS\)/);
  const modal = await read("components/voom/modals/CreateContentModal.tsx");
  assert.match(modal, /Import an existing video/);
  assert.match(modal, /create\("reel", "existing_content"\)/);
  assert.match(modal, /create\("instagram_post", "own_asset"\)/);
  assert.match(modal, /create\("instagram_post", "mara"\)/);
});

test("existing-content suggestions are metadata-only and disclose that MARA did not watch", async () => {
  const route = await read("app/api/posts/[id]/suggest/route.ts");
  assert.match(route, /buildExistingContentPayload/);
  assert.match(route, /inspectedVisual: false/);
  assert.match(route, /disclosure: EXISTING_CONTENT_DISCLOSURE/);
  assert.match(route, /postAssetKindForMime\(post\.visual\.mimeType\)/);
  assert.doesNotMatch(route, /bytes|arrayBuffer|base64|createMediaProvider|getMediaConfig/);
  const editor = await read("components/voom/modals/PostEditorModal.tsx");
  assert.match(editor, /MARA has not seen this file/);
});

// ---------------------------------------------------------------------------
// Scheduling, approval and calendar integration
// ---------------------------------------------------------------------------

test("posts can be saved as a draft, scheduled, and approved without publishing", async () => {
  const route = await read("app/api/posts/[id]/route.ts");
  assert.match(route, /action === "approve"/);
  assert.match(route, /approvePostDraft\(admin, user\.id, id\)/);
  assert.match(route, /postApprovalBlockers\(\{ caption: existing\.caption, hasVisual: existing\.visualReady, kind: existing\.kind \}\)/);
  assert.match(route, /checkScheduleInstant/);
  assert.match(route, /Voom will automatically publish this to Instagram at the scheduled time\./);
  const data = await read("lib/post/server-data.ts");
  assert.match(data, /update\(\{ status: "approved" \}\)/);
  assert.match(data, /export async function syncPostToCalendar/);
});

test("approved posts appear on the existing Content Calendar with a resolved type", async () => {
  const data = await read("lib/post/server-data.ts");
  // Only approved content is mirrored; drafts are removed again.
  assert.match(data, /if \(view\.internalState === "draft"\) \{/);
  assert.match(data, /calendarStatusFor\(view\.internalState\)/);
  assert.match(data, /channel: calendarChannelFor\(view\.kind\)/);
  assert.match(data, /onConflict: "owner_user_id,source_draft_id"/);
  assert.match(data, /from\("content_calendar_items"\)/);
  assert.match(data, /export async function resolveCalendarContentTypes/);
  assert.match(data, /originByDraft/);

  const listRoute = await read("app/api/voom/calendar/route.ts");
  assert.match(listRoute, /resolveCalendarContentTypes/);
  assert.match(listRoute, /contentType: labels\.get\(String\(item\.source_draft_id\)\) \?\? null/);

  const detailRoute = await read("app/api/voom/calendar/[id]/route.ts");
  assert.match(detailRoute, /resolveCalendarContentType\(createAdminClient\(\), user\.id, item\.source_draft_id\)/);
  assert.match(detailRoute, /contentType,/);

  const modal = await read("components/voom/modals/SavedCalendarDetailModal.tsx");
  assert.match(modal, /contentType: string \| null/);
  assert.match(modal, /label="Content type"/);
  assert.match(modal, /Nothing has been published or sent externally/);

  const page = await read("app/app/(shell)/calendar/page.tsx");
  assert.match(page, /CreateContentModal/);
  assert.match(page, /Create content/);
  assert.match(page, /item\.contentType/);
});

// ---------------------------------------------------------------------------
// Owner isolation and client-readability
// ---------------------------------------------------------------------------

test("every Post Studio route is authenticated and owner-scoped", async () => {
  const routes = [
    "app/api/posts/route.ts",
    "app/api/posts/[id]/route.ts",
    "app/api/posts/[id]/asset/route.ts",
    "app/api/posts/[id]/generate/route.ts",
    "app/api/posts/[id]/suggest/route.ts",
  ];
  for (const path of routes) {
    const source = await read(path);
    assert.match(source, /getCurrentUser\(\)/, `${path} must require a user`);
    assert.match(source, /Please log in again\./, `${path} must reject anonymous callers`);
    assert.match(source, /user\.id/, `${path} must scope every query to the caller`);
  }
  const data = await read("lib/post/server-data.ts");
  const ownerScopes = data.match(/eq\("owner_user_id", ownerId\)/g) ?? [];
  assert.ok(ownerScopes.length >= 12, `expected broad owner scoping, found ${ownerScopes.length}`);
});

test("storage_path and provider secrets never reach the client", async () => {
  const sql = await read("supabase/migrations/0021_instagram_post_studio.sql");
  const grant = sql.match(/grant select \(([\s\S]+?)\) on table public\.post_draft_assets to authenticated/)?.[1] ?? "";
  assert.doesNotMatch(grant, /storage_path/);

  for (const path of [
    "components/voom/modals/PostEditorModal.tsx",
    "components/voom/modals/CreateContentModal.tsx",
    "app/app/(shell)/studio/page.tsx",
  ]) {
    const source = await read(path);
    assert.doesNotMatch(source, /storage_path/, `${path} must not reference storage_path`);
    assert.doesNotMatch(source, /MEDIA_API_KEY|AI_API_KEY|SUPABASE_SECRET_KEY|NEXT_PUBLIC_[A-Z_]*SECRET/);
    assert.doesNotMatch(source, /createAdminClient|server-only/);
  }
  const data = await read("lib/post/server-data.ts");
  assert.match(data, /^import "server-only";/m);
  const example = await read(".env.example");
  for (const name of ["MEDIA_API_KEY", "AI_API_KEY", "SUPABASE_SECRET_KEY"]) {
    assert.doesNotMatch(example, new RegExp(`NEXT_PUBLIC_${name}`));
  }
});

// ---------------------------------------------------------------------------
// No external publishing, no paid generation in tests, Reels preserved
// ---------------------------------------------------------------------------

test("Post Studio never calls Instagram and never claims a post went live", async () => {
  const sources = await Promise.all([
    read("app/api/posts/route.ts"),
    read("app/api/posts/[id]/route.ts"),
    read("app/api/posts/[id]/asset/route.ts"),
    read("app/api/posts/[id]/generate/route.ts"),
    read("app/api/posts/[id]/suggest/route.ts"),
    read("lib/post/server-data.ts"),
    read("lib/post/core.ts"),
    read("lib/post/prompt.ts"),
    read("components/voom/modals/PostEditorModal.tsx"),
    read("components/voom/modals/CreateContentModal.tsx"),
    read("app/app/(shell)/studio/page.tsx"),
  ]);
  const all = sources.join("\n");
  assert.doesNotMatch(all, /graph\.instagram\.com|media_publish|instagram_publish_jobs/i);
  assert.doesNotMatch(all, /publishToInstagram|publishPost|POST_TO_INSTAGRAM/i);
  // No status value or user-facing state label may report a post as live. The
  // source does mention the word in prose, to explain that Voom deliberately
  // has no such state, so the guard checks the data rather than the prose.
  assert.doesNotMatch(all, /status:\s*["']posted/i);
  assert.doesNotMatch(JSON.stringify(core.POST_STATE_LABELS), /posted/i);
  assert.doesNotMatch(JSON.stringify(core.POST_INTERNAL_STATES), /posted/i);
  assert.ok(!Object.values(core.POST_STATE_LABELS).some((label) => /posted/i.test(label)));
  assert.match(all, /Nothing is published to Instagram/);
  // The publishing capability stays switched off elsewhere in Voom.
  const tools = await read("lib/mara/tools.ts");
  assert.match(tools, /publishingAvailable: false/);
});

test("no test executes a provider, so no real paid generation runs in the suite", async () => {
  const files = (await readdir(new URL("tests/", root))).filter((name) => name.endsWith(".test.mjs"));
  for (const name of files) {
    const source = await read(`tests/${name}`);
    // Routes and providers are only ever read as text; the suite never imports
    // a route module or a provider, and never sets provider credentials.
    assert.doesNotMatch(source, /import\([^)]*(media\/provider|lib\/media"|api\/posts|generate\/route)/, `${name} must not import a provider or route`);
    // A provider credential may only ever be set to an obvious decoy (the
    // secret-exclusivity tests plant look-alikes to prove they are ignored),
    // and never to something a provider could accept.
    for (const match of source.matchAll(/process\.env\.(MEDIA_API_KEY|MEDIA_PROVIDER|MEDIA_IMAGE_MODEL|AI_API_KEY)\s*=\s*([^;\n]+)/g)) {
      assert.match(match[2], /decoy|placeholder|not-a-real|fake/i, `${name} must not set a plausible provider credential (${match[1]} = ${match[2].trim()})`);
    }
  }
  // Post Studio's own coverage is pure logic plus source-text assertions.
  const studioTests = await read("tests/post-studio.test.mjs");
  assert.match(studioTests, /lib\/post\/core\.ts/);
  assert.match(studioTests, /lib\/post\/prompt\.ts/);
  assert.match(studioTests, /readFile/);
});

test("the existing Reel workflow and other flows are left intact", async () => {
  // The Reel studio page, its production route and asset pack are untouched by
  // Post Studio: none of them may start importing Post Studio code.
  const [reels, produce, assets, board, workflow, automation] = await Promise.all([
    read("app/app/(shell)/reels/page.tsx"),
    read("app/api/reels/produce/[actionId]/route.ts"),
    read("app/api/reels/assets/[actionId]/route.ts"),
    read("components/voom/operating/ApprovalsBoard.tsx"),
    read("lib/voom/workflow/service.ts"),
    read("lib/voom/weekly-automation.ts"),
  ]);
  for (const [name, source] of [["reels", reels], ["produce", produce], ["assets", assets], ["board", board]]) {
    assert.doesNotMatch(source, /@\/lib\/post\//, `${name} must not depend on Post Studio`);
  }
  // The sample Reel studio was removed; the route forwards to the real studio
  // while the production flow itself stays untouched.
  assert.match(reels, /redirect\("\/app\/studio"\)/);
  assert.match(produce, /productionStatus: "produced"/);
  assert.match(assets, /add_reel_draft_asset/);
  assert.match(board, /Create with MARA/);
  // Campaign, email and SMS automation must stay send-free.
  assert.doesNotMatch(workflow, /sendApprovedCampaign|claim_campaign_send|createResendClient|createClickSendClient/);
  assert.doesNotMatch(automation, /claim_campaign_send|resend|twilio|clicksend/i);

  // Reels created in Post Studio reuse the existing reel draft kind.
  assert.equal(core.REEL_DRAFT_KIND, "reel");
  const migration = await read("supabase/migrations/0021_instagram_post_studio.sql");
  assert.doesNotMatch(migration, /reel_draft_assets/, "0021 must not touch the Reel asset table");
});

test("the Create content entry point is reachable from navigation and the calendar", async () => {
  const nav = await read("components/voom/shell/nav.ts");
  assert.match(nav, /id: "studio", n: "Create Content"/);
  assert.match(nav, /studio: "Create Content"/);
  const store = await read("lib/voom/store.tsx");
  assert.match(store, /studio: "\/app\/studio"/);
  const page = await read("app/app/(shell)/studio/page.tsx");
  assert.match(page, /title="Create content"/);
  assert.match(page, /Instagram Post/);
  assert.match(page, /Reel/);
  assert.match(page, /fetch\("\/api\/posts"/);
});
