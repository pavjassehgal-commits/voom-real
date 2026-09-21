import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const sqlStatements = (sql) => sql.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");

const core = await import("../lib/post/core.ts");
const { detectReelAsset } = await import("../lib/media/reel-asset.ts");
const { persistUploadedPostAsset, PostAssetPersistError } = await import("../lib/post/asset-persist.ts");

const brand = (s) => { const out = new Uint8Array(4); for (let i = 0; i < 4; i++) out[i] = s.charCodeAt(i) || 0x20; return out; };
const ftyp = (major, compat = []) => {
  const size = 16 + 4 * compat.length;
  const bytes = new Uint8Array(size);
  bytes[0] = (size >> 24) & 0xff; bytes[1] = (size >> 16) & 0xff; bytes[2] = (size >> 8) & 0xff; bytes[3] = size & 0xff;
  bytes.set(new TextEncoder().encode("ftyp"), 4);
  bytes.set(brand(major), 8);
  compat.forEach((c, i) => bytes.set(brand(c), 16 + i * 4));
  return bytes;
};

const OWNER = "11111111-1111-4111-8111-111111111111";
const DRAFT = "22222222-2222-4222-8222-222222222222";
const STORAGE = `${OWNER}/post-assets/deadbeefdeadbeef-${DRAFT}.mp4`;

function write(input) {
  return core.buildPostDraftAssetWrite({
    ownerUserId: OWNER,
    draftId: DRAFT,
    storagePath: STORAGE,
    displayName: input.displayName ?? "asset.bin",
    mimeType: input.mimeType ?? "video/mp4",
    byteSize: input.byteSize ?? 964_000,
    origin: input.origin,
    kind: input.kind,
  });
}

// ---------------------------------------------------------------------------
// Origin mapping against the production CHECK
// ---------------------------------------------------------------------------

test("existing Reel import writes origin='uploaded_existing'", () => {
  const row = write({ origin: "existing_content", kind: "reel", displayName: "SYNRAPAY_REEL_FINAL.mp4" });
  assert.equal(row.origin, "uploaded_existing");
  assert.equal(core.assetOriginFor("existing_content"), "uploaded_existing");
  assert.equal(core.assetOriginFor("own_asset", "reel"), "uploaded_existing");
  assert.equal(core.originForAsset(row.origin), "existing_content");
  assert.equal(core.postTypeLabel("reel", row.origin), "Existing content");
  assert.equal(core.isProductionPostDraftAssetWrite(row), true);
});

test("own Post asset writes origin='uploaded_asset'", () => {
  const own = write({ origin: "own_asset", kind: "instagram_post", displayName: "studio.jpg", mimeType: "image/jpeg", byteSize: 80_000 });
  const mara = write({ origin: "mara", kind: "instagram_post", displayName: "MARA visual", mimeType: "image/png", byteSize: 120_000 });
  assert.equal(own.origin, "uploaded_asset");
  assert.equal(mara.origin, "uploaded_asset");
  assert.equal(core.assetOriginFor("own_asset"), "uploaded_asset");
  assert.equal(core.assetOriginFor("mara"), "uploaded_asset");
  assert.equal(core.originForAsset("uploaded_asset"), "own_asset");
  assert.equal(core.isProductionPostDraftAssetWrite(own), true);
  assert.equal(core.isProductionPostDraftAssetWrite(mara), true);
});

test("write rows never include format and only use production columns", () => {
  const row = write({ origin: "existing_content", kind: "reel" });
  assert.equal("format" in row, false);
  assert.deepEqual(Object.keys(row).sort(), [...core.POST_DRAFT_ASSET_WRITE_COLUMNS].sort());
  for (const key of Object.keys(row)) {
    assert.ok(core.POST_DRAFT_ASSET_PRODUCTION_COLUMNS.includes(key), `${key} must exist in production 0021`);
  }
  assert.ok(!core.POST_DRAFT_ASSET_PRODUCTION_COLUMNS.includes("format"));
  assert.equal(core.isProductionPostDraftAssetWrite({ ...row, format: "1:1" }), false);
  assert.equal(core.isProductionPostDraftAssetWrite({ ...row, origin: "existing_content" }), false);
  assert.equal(core.isProductionPostDraftAssetWrite({ ...row, origin: "user_upload" }), false);
});

// ---------------------------------------------------------------------------
// Draft channel remains the source of truth for 1:1 / 4:5
// ---------------------------------------------------------------------------

test("draft channel remains the source of truth for format", async () => {
  assert.equal(core.encodeDraftChannel("instagram_post", "4:5"), "Instagram · 4:5");
  assert.equal(core.decodeDraftFormat("Instagram · 4:5"), "4:5");
  assert.equal(core.decodeDraftFormat("Reel · 1:1"), "1:1");

  const data = await read("lib/post/server-data.ts");
  assert.match(data, /channel: encodeDraftChannel\(input\.kind, format\)/);
  assert.match(data, /channel: encodeDraftChannel\(existing\.kind, nextFormat\)/);
  assert.match(data, /const format = decodeDraftFormat\(draft\.channel as string \| undefined\);/);
  assert.doesNotMatch(data, /ASSET_COLUMNS = "[^"]*\bformat\b/);
  assert.doesNotMatch(data, /from\(POST_ASSET_TABLE\)\.update\(\{ format \}\)/);
  assert.doesNotMatch(data, /mirrorAssetFormat/);

  const persist = data.slice(data.indexOf("export async function putPostAsset"), data.indexOf("export async function verifyPostAssetStored"));
  assert.match(persist, /buildPostDraftAssetWrite/);
  assert.doesNotMatch(persist, /decodeDraftFormat/);
  assert.doesNotMatch(persist, /\bformat\s*,/);
});

// ---------------------------------------------------------------------------
// Synrapay detection (already fixed in PR #11; keep the regression)
// ---------------------------------------------------------------------------

test("valid Synrapay qt-branded .mp4 passes detection", async () => {
  const bytes = ftyp("qt  ", ["isom", "mp42"]);
  assert.deepEqual(detectReelAsset(bytes, { name: "SYNRAPAY_REEL_FINAL.mp4" }), {
    mimeType: "video/mp4", extension: "mp4", kind: "video",
  });
  const asset = await read("lib/post/asset.ts");
  assert.match(asset, /detectReelAsset\(bytes, name \? \{ name \} : undefined\)/);
});

// ---------------------------------------------------------------------------
// Storage upload + DB upsert with the production 0021 row shape
// ---------------------------------------------------------------------------

test("storage upload + DB upsert succeeds with production 0021 shape", async () => {
  const objects = new Set();
  const rows = [];
  const row = write({ origin: "existing_content", kind: "reel", displayName: "SYNRAPAY_REEL_FINAL.mp4" });

  const result = await persistUploadedPostAsset({
    upload: async () => { objects.add(row.storage_path); },
    loadPreviousPath: async () => null,
    upsert: async (written) => { rows.push(written); },
    removeUploaded: async () => { objects.delete(row.storage_path); },
    row,
  });

  assert.equal(result.previousStoragePath, null);
  assert.equal(objects.has(row.storage_path), true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].origin, "uploaded_existing");
  assert.equal(rows[0].status, "uploaded");
  assert.equal("format" in rows[0], false);
  assert.equal(core.isProductionPostDraftAssetWrite(rows[0]), true);

  const data = await read("lib/post/server-data.ts");
  assert.match(data, /persistUploadedPostAsset/);
  assert.match(data, /buildPostDraftAssetWrite/);
  const body = data.slice(data.indexOf("export async function putPostAsset"));
  const uploadAt = body.indexOf(".upload(storagePath, input.bytes");
  const upsertAt = body.indexOf("onConflict: \"owner_user_id,draft_id\"");
  assert.ok(uploadAt > -1 && upsertAt > -1 && uploadAt < upsertAt, "storage upload must precede the metadata row");
});

test("DB failure cleans up the newly uploaded storage object", async () => {
  const objects = new Set();
  const row = write({ origin: "own_asset", kind: "instagram_post", displayName: "hero.jpg", mimeType: "image/jpeg" });

  await assert.rejects(
    () => persistUploadedPostAsset({
      upload: async () => { objects.add(row.storage_path); },
      loadPreviousPath: async () => null,
      upsert: async () => { throw new Error("postgres"); },
      removeUploaded: async () => { objects.delete(row.storage_path); },
      row,
    }),
    (error) => error instanceof PostAssetPersistError && error.code === "db_failure" && error.phase === "upsert",
  );
  assert.equal(objects.size, 0, "the orphan object must be removed");

  const objectsAfterPreviousFailure = new Set();
  await assert.rejects(
    () => persistUploadedPostAsset({
      upload: async () => { objectsAfterPreviousFailure.add(row.storage_path); },
      loadPreviousPath: async () => { throw new Error("postgres"); },
      upsert: async () => { throw new Error("should not upsert"); },
      removeUploaded: async () => { objectsAfterPreviousFailure.delete(row.storage_path); },
      row,
    }),
    (error) => error instanceof PostAssetPersistError && error.code === "db_failure" && error.phase === "previous",
  );
  assert.equal(objectsAfterPreviousFailure.size, 0);

  const data = await read("lib/post/server-data.ts");
  assert.match(data, /await admin\.storage\.from\(POST_ASSET_BUCKET\)\.remove\(\[storagePath\]\)/);
  assert.match(data, /Never leave an orphan object behind if the link could not be written/);
});

test("a storage failure does not attempt a DB write", async () => {
  let upserted = false;
  const row = write({ origin: "own_asset", kind: "instagram_post" });
  await assert.rejects(
    () => persistUploadedPostAsset({
      upload: async () => { throw new Error("storage"); },
      loadPreviousPath: async () => null,
      upsert: async () => { upserted = true; },
      removeUploaded: async () => { throw new Error("nothing to remove"); },
      row,
    }),
    (error) => error instanceof PostAssetPersistError && error.code === "storage_failure",
  );
  assert.equal(upserted, false);
});

// ---------------------------------------------------------------------------
// Repo 0021 matches production; the only 0022 is Instagram auto-publishing
// ---------------------------------------------------------------------------

test("migration 0021 source matches the production shape", async () => {
  const sql = await read("supabase/migrations/0021_instagram_post_studio.sql");
  assert.match(sql, /ALREADY APPLIED to the production Supabase database/i);
  assert.match(sql, /Do NOT run this file again/i);
  assert.match(sql, /THERE IS NO format COLUMN/);
  assert.match(sql, /origin CHECK: origin in \('uploaded_asset','uploaded_existing'\)/);
  assert.match(sql, /status CHECK: status = 'uploaded'/);
  assert.match(sql, /drop policy if exists "post_draft_assets_select_own"\s+on public\.post_draft_assets;/);

  const statements = sqlStatements(sql);
  assert.doesNotMatch(statements, /format text/);
  assert.doesNotMatch(statements, /check \(format in/);
  assert.match(statements, /check \(origin in \('uploaded_asset','uploaded_existing'\)\)/);
  assert.match(statements, /check \(status = 'uploaded'\)/);
  assert.doesNotMatch(statements, /existing_content/);
  assert.doesNotMatch(statements, /mara_generated/);
  assert.doesNotMatch(statements, /user_upload/);

  const create = statements.match(/create table if not exists public\.post_draft_assets \(([\s\S]*?)\);/);
  assert.ok(create, "post_draft_assets must be created");
  const expected = [
    "id", "owner_user_id", "draft_id", "storage_path", "display_name",
    "mime_type", "byte_size", "origin", "status", "created_at", "updated_at",
  ];
  for (const column of expected) {
    assert.match(create[1], new RegExp(`\\n  ${column} `), `${column} must exist on production post_draft_assets`);
  }
  assert.doesNotMatch(create[1], /\n  format /);

  const grant = sql.match(/grant select \(([\s\S]+?)\) on table public\.post_draft_assets to authenticated/)?.[1] ?? "";
  assert.doesNotMatch(grant, /\bformat\b/);
  assert.doesNotMatch(grant, /storage_path/);
});

test("0021 matches production and 0022-0028 migrations stay scoped", async () => {
  const files = await readdir(new URL("supabase/migrations/", root));
  assert.ok(files.includes("0021_instagram_post_studio.sql"));
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

test("no code writes or selects post_draft_assets.format", async () => {
  const paths = [
    "lib/post/core.ts",
    "lib/post/asset.ts",
    "lib/post/asset-persist.ts",
    "lib/post/server-data.ts",
    "lib/post/prompt.ts",
    "app/api/posts/route.ts",
    "app/api/posts/[id]/route.ts",
    "app/api/posts/[id]/asset/route.ts",
    "app/api/posts/[id]/generate/route.ts",
    "app/api/posts/[id]/suggest/route.ts",
    "components/voom/modals/PostEditorModal.tsx",
    "components/voom/modals/CreateContentModal.tsx",
    "supabase/migrations/0021_instagram_post_studio.sql",
  ];
  for (const path of paths) {
    const source = await read(path);
    assert.doesNotMatch(source, /from\("post_draft_assets"\)[\s\S]{0,180}\.select\([^)]*\bformat\b/, `${path} must not select format`);
    assert.doesNotMatch(source, /from\(POST_ASSET_TABLE\)[\s\S]{0,180}\.select\([^)]*\bformat\b/, `${path} must not select format`);
    assert.doesNotMatch(source, /ASSET_COLUMNS = "[^"]*\bformat\b/, `${path} must not list format in ASSET_COLUMNS`);
    assert.doesNotMatch(source, /from\("post_draft_assets"\)\.update\(\{ format \}\)/, `${path} must not write format`);
    assert.doesNotMatch(source, /from\(POST_ASSET_TABLE\)\.update\(\{ format \}\)/, `${path} must not write format`);
    assert.doesNotMatch(source, /mirrorAssetFormat/, `${path} must not mirror format onto the asset`);
  }
});

test("ingestion routes persist production origins, not legacy values", async () => {
  const [data, route, generate] = await Promise.all([
    read("lib/post/server-data.ts"),
    read("app/api/posts/[id]/asset/route.ts"),
    read("app/api/posts/[id]/generate/route.ts"),
  ]);
  assert.match(data, /buildPostDraftAssetWrite/);
  assert.doesNotMatch(data, /origin: assetOriginFor\(input\.origin\)/);
  assert.match(route, /post\.kind === "reel"/);
  assert.match(generate, /origin: "mara"/);
  assert.equal(core.assetOriginFor("mara"), "uploaded_asset");
  assert.doesNotMatch(`${data}\n${route}\n${generate}`, /mara_generated|user_upload/);
});

test("Post Studio never publishes to Instagram", async () => {
  const sources = await Promise.all([
    read("app/api/posts/route.ts"),
    read("app/api/posts/[id]/route.ts"),
    read("app/api/posts/[id]/asset/route.ts"),
    read("app/api/posts/[id]/generate/route.ts"),
    read("lib/post/server-data.ts"),
    read("lib/post/core.ts"),
    read("lib/post/asset-persist.ts"),
  ]);
  const all = sources.join("\n");
  assert.doesNotMatch(all, /graph\.instagram\.com|media_publish|instagram_publish_jobs/i);
  assert.doesNotMatch(all, /publishToInstagram|publishPost|POST_TO_INSTAGRAM/i);
});
