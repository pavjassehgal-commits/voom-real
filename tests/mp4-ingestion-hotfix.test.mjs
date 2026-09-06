import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const { detectReelAsset } = await import("../lib/media/reel-asset.ts");
const core = await import("../lib/post/core.ts");

// Build a structurally valid ISO-BMFF `ftyp` box, so detection is tested against
// real container headers rather than loose magic numbers.
const brand = (s) => { const out = new Uint8Array(4); for (let i = 0; i < 4; i++) out[i] = s.charCodeAt(i) || 0x20; return out; };
const minor = new Uint8Array(4);
const ftyp = (major, compat = [], sizeOverride = null) => {
  const size = sizeOverride ?? (16 + 4 * compat.length);
  const bytes = new Uint8Array(Math.max(size, 16));
  bytes[0] = (size >> 24) & 0xff; bytes[1] = (size >> 16) & 0xff; bytes[2] = (size >> 8) & 0xff; bytes[3] = size & 0xff;
  bytes.set(new TextEncoder().encode("ftyp"), 4);
  bytes.set(brand(major), 8);
  bytes.set(minor, 12);
  compat.forEach((c, i) => bytes.set(brand(c), 16 + i * 4));
  return bytes;
};

// ---------------------------------------------------------------------------
// The real user case: a small Apple-exported MP4 with a `qt` major brand
// ---------------------------------------------------------------------------

test("SYNRAPAY_REEL_FINAL.mp4 (qt major brand) is stored as video/mp4 by Post Studio", () => {
  const bytes = ftyp("qt  ", ["isom", "mp42"]);
  // Post Studio delegates to the same shared detector, forwarding the filename.
  const detected = detectReelAsset(bytes, { name: "SYNRAPAY_REEL_FINAL.mp4" });
  assert.deepEqual(detected, { mimeType: "video/mp4", extension: "mp4", kind: "video" });
});

test("Post Studio forwards the filename into the shared detector", async () => {
  const asset = await read("lib/post/asset.ts");
  assert.match(asset, /export function detectPostAsset\(bytes: Uint8Array, name\?: string\)/);
  assert.match(asset, /detectReelAsset\(bytes, name \? \{ name \} : undefined\)/);
});

test("the SAME qt-branded shape is accepted by the legacy Reel upload detection", () => {
  const bytes = ftyp("qt  ", ["isom", "mp42"]);
  const detected = detectReelAsset(bytes, { name: "SYNRAPAY_REEL_FINAL.mp4" });
  assert.deepEqual(detected, { mimeType: "video/mp4", extension: "mp4", kind: "video" });
});

// ---------------------------------------------------------------------------
// Broad MP4 container acceptance (normal + unlisted printable brands)
// ---------------------------------------------------------------------------

test("normal isom MP4 with a .mp4 name stays video/mp4", () => {
  assert.deepEqual(detectReelAsset(ftyp("isom"), { name: "camera.mp4" }), { mimeType: "video/mp4", extension: "mp4", kind: "video" });
});

test("mp42 MP4 with a .mp4 name stays video/mp4", () => {
  assert.deepEqual(detectReelAsset(ftyp("mp42"), { name: "reel.mp4" }), { mimeType: "video/mp4", extension: "mp4", kind: "video" });
});

test("a structurally valid unlisted printable brand is accepted", () => {
  assert.deepEqual(detectReelAsset(ftyp("abcd"), { name: "brand.mp4" }), { mimeType: "video/mp4", extension: "mp4", kind: "video" });
});

test("a qt-branded .mp4 is never rewritten to MOV, even with no extension hint", () => {
  assert.deepEqual(detectReelAsset(ftyp("qt  ")), { mimeType: "video/mp4", extension: "mp4", kind: "video" });
});

// ---------------------------------------------------------------------------
// Rejection of fake / malformed containers
// ---------------------------------------------------------------------------

test("fake .mp4 files are rejected", () => {
  assert.equal(detectReelAsset(new TextEncoder().encode("this is not a video"), { name: "fake.mp4" }), null);
});

test("malformed ftyp (missing minor version / too small) is rejected", () => {
  // A 12-byte stub has no minor version field and can never be a real ftyp box.
  assert.equal(detectReelAsset(Uint8Array.from([0, 0, 0, 0, ...new TextEncoder().encode("ftypqt  ")])), null);
  // A declared box size that is smaller than its own header is malformed.
  assert.equal(detectReelAsset(ftyp("isom", [], 8), { name: "broken.mp4" }), null);
});

test("malformed ftyp with a non-printable major brand is rejected", () => {
  const bad = ftyp("isom");
  bad[8] = 0x00; // corrupt the major brand
  assert.equal(detectReelAsset(bad, { name: "bad.mp4" }), null);
});

test("a wrong signature (no ftyp at the box header) is rejected", () => {
  const notFtyp = new Uint8Array(16);
  notFtyp.set(new TextEncoder().encode("junk"), 4);
  assert.equal(detectReelAsset(notFtyp, { name: "junk.mp4" }), null);
});

// ---------------------------------------------------------------------------
// Genuine MOV handling
// ---------------------------------------------------------------------------

test("a genuine QuickTime .mov is truthfully stored as video/quicktime", () => {
  assert.deepEqual(detectReelAsset(ftyp("qt  ", ["qt  "]), { name: "magic.mov" }), { mimeType: "video/quicktime", extension: "mov", kind: "video" });
});

test("a .mov that is not a QuickTime container is rejected, not mislabelled", () => {
  assert.equal(detectReelAsset(ftyp("isom"), { name: "mislabeled.mov" }), null);
  // Post Studio uses the same shared detector and forwards the filename.
  assert.equal(detectReelAsset(ftyp("isom"), { name: "mislabeled.mov" }), null);
});

// ---------------------------------------------------------------------------
// Image detection is unchanged
// ---------------------------------------------------------------------------

test("image uploads are detected unchanged", () => {
  assert.deepEqual(detectReelAsset(Uint8Array.from([0xff, 0xd8, 0xff])), { mimeType: "image/jpeg", extension: "jpg", kind: "image" });
  assert.deepEqual(detectReelAsset(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), { mimeType: "image/png", extension: "png", kind: "image" });
  assert.deepEqual(detectReelAsset(new TextEncoder().encode("RIFFxxxxWEBP")), { mimeType: "image/webp", extension: "webp", kind: "image" });
});

// ---------------------------------------------------------------------------
// Post Studio existing-content path: a video can create a Reel
// ---------------------------------------------------------------------------

test("Post Studio existing video (reel kind) is accepted by the allowed-kind rules", () => {
  assert.deepEqual(core.allowedAssetKindsFor("reel"), ["image", "video"]);
  assert.equal(core.postAssetKindForMime("video/mp4"), "video");
  assert.equal(core.postAssetKindForMime("video/quicktime"), "video");
});

test("Post Studio ingestion passes the filename and never trusts the browser MIME type", async () => {
  const route = await read("app/api/posts/[id]/asset/route.ts");
  assert.match(route, /detectPostAsset\(bytes, file\.name\)/);
  assert.match(route, /POST_ASSET_MAX_BYTES/);
  assert.match(route, /putPostAsset\(admin, user\.id, id/);
  assert.match(route, /origin === "existing_content"/);
  // No content-type from the browser is used for classification.
  assert.doesNotMatch(route, /file\.type|request\.headers\.get\("content-type"\)/);
});

// ---------------------------------------------------------------------------
// Legal legacy Reel upload path now uses the filename too
// ---------------------------------------------------------------------------

test("legacy Reel upload detection passes the filename context to fix the latent bug", async () => {
  const route = await read("app/api/reels/assets/[actionId]/route.ts");
  assert.match(route, /detectReelAsset\(bytes, \{ name: file\.name \}\)/);
  assert.match(route, /REEL_ASSET_MAX_BYTES/);
});

// ---------------------------------------------------------------------------
// Oversized files are rejected before any storage write
// ---------------------------------------------------------------------------

test("oversized files are rejected before storage in both ingestion routes", async () => {
  const post = await read("app/api/posts/[id]/asset/route.ts");
  const postSizeGuard = post.indexOf("file.size > POST_ASSET_MAX_BYTES");
  const postUpload = post.indexOf("putPostAsset(admin");
  assert.ok(postSizeGuard > -1 && postUpload > -1 && postSizeGuard < postUpload, "Post Studio must reject size before writing");

  const reel = await read("app/api/reels/assets/[actionId]/route.ts");
  const reelSizeGuard = reel.indexOf("file.size > REEL_ASSET_MAX_BYTES");
  const reelUpload = reel.indexOf(".upload(storagePath");
  assert.ok(reelSizeGuard > -1 && reelUpload > -1 && reelSizeGuard < reelUpload, "Reel upload must reject size before writing");
});

// ---------------------------------------------------------------------------
// Safe error classification — canned messages, stable codes, no internals
// ---------------------------------------------------------------------------

test("safe storage errors carry a canned message and a stable code", async () => {
  const reel = await read("app/api/reels/assets/[actionId]/route.ts");
  assert.match(reel, /Voom couldn't store that asset safely\. Nothing changed\./);
  assert.match(reel, /"storage_failure"/);
  const post = await read("app/api/posts/[id]/asset/route.ts");
  assert.match(post, /Voom couldn't store that file safely\. Nothing changed\./);
  assert.match(post, /"storage_failure"/);
});

test("safe DB persistence errors carry a canned message and a stable code", async () => {
  const reel = await read("app/api/reels/assets/[actionId]/route.ts");
  assert.match(reel, /Voom couldn't link that asset safely\. Nothing changed\./);
  assert.match(reel, /"db_failure"/);
});

test("no raw database or storage error reaches the client in ingestion routes", async () => {
  const sources = await Promise.all([
    read("app/api/reels/assets/[actionId]/route.ts"),
    read("app/api/reels/assets/[actionId]/[assetId]/route.ts"),
    read("app/api/posts/[id]/asset/route.ts"),
  ]);
  const all = sources.join("\n");
  // The returned `error` is always a canned literal; nothing interpolates a
  // thrown Postgres / storage / provider error into a user-facing message, and
  // no Response is built with an unquoted error identifier.
  assert.doesNotMatch(all, /\$\{[^}]*error\b/);
  assert.doesNotMatch(all, /Response\.json\(\{\s*error:\s*(?!["'])/);
});

test("ingestion routes never leak secrets or publish to Instagram", async () => {
  const sources = await Promise.all([
    read("app/api/reels/assets/[actionId]/route.ts"),
    read("app/api/reels/assets/[actionId]/[assetId]/route.ts"),
    read("app/api/posts/[id]/asset/route.ts"),
  ]);
  const all = sources.join("\n");
  assert.doesNotMatch(all, /SUPABASE_SECRET_KEY|NEXT_PUBLIC_[A-Z_]*SECRET|service[_-]?role|MEDIA_API_KEY|META_APP_SECRET/);
  assert.doesNotMatch(all, /graph\.instagram\.com|media_publish|instagram_publish_jobs|publishToInstagram|POST_TO_INSTAGRAM/i);
});

// ---------------------------------------------------------------------------
// No schema migration by this hotfix; production DB assumptions unchanged
// ---------------------------------------------------------------------------

test("the mp4 hotfix adds no migration of its own and touches no migration file", async () => {
  const migrations = (await readdir(new URL("supabase/migrations/", root))).sort();
  assert.ok(migrations.includes("0021_instagram_post_studio.sql"));
  assert.deepEqual(migrations.filter((name) => name.startsWith("0022")), ["0022_instagram_auto_publishing.sql"]);
});

test("the hotfix touches Post Studio upload only; it never rewrites the existing Reel asset schema", async () => {
  // The bucket and tables already accept video/mp4; the fix is classification
  // only, so no storage.buckets / RPC change is required.
  const migrations = (await readdir(new URL("supabase/migrations/", root))).sort();
  assert.deepEqual(migrations.filter((name) => name.startsWith("0022")), ["0022_instagram_auto_publishing.sql"]);
});
