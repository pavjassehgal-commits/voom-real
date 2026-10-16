import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const upload = await import("../lib/tiktok/video-upload.ts");

function mp4Bytes() {
  return new Uint8Array(Buffer.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0, 0x69, 0x73, 0x6f, 0x6d]));
}

test("TikTok upload accepts a real MP4 and rejects empty, renamed, non-MP4 and oversized files", () => {
  assert.equal(upload.validateTikTokVideoUpload(mp4Bytes(), "launch.mp4").ok, true);
  assert.deepEqual(upload.validateTikTokVideoUpload(new Uint8Array(), "empty.mp4"), { ok: false, code: "empty" });
  assert.deepEqual(upload.validateTikTokVideoUpload(mp4Bytes(), "launch.mov"), { ok: false, code: "not_mp4" });
  assert.deepEqual(upload.validateTikTokVideoUpload(new Uint8Array(Buffer.from("not a video")), "fake.mp4"), { ok: false, code: "not_mp4" });
  assert.deepEqual(
    upload.validateTikTokVideoUpload(new Uint8Array(20 * 1024 * 1024 + 1), "large.mp4"),
    { ok: false, code: "too_large" },
  );
});

test("TikTok upload route is owner-scoped, business-scoped, private, replacement-safe and never calls TikTok", async () => {
  const route = await read("app/api/social-drafts/[id]/asset/route.ts");
  assert.match(route, /getCurrentUser\(\)/);
  assert.match(route, /getSocialDraft\(admin, user\.id, id\)/);
  assert.match(route, /draft\.kind !== "tiktok_video"/);
  assert.match(route, /from\("businesses"\)[\s\S]*eq\("owner_user_id", user\.id\)/);
  assert.match(route, /updateSocialDraft\(admin, user\.id, id, \{ decision: "draft" \}\)/, "replacement withdraws prior consent and queue approval");
  assert.match(route, /putPostAsset\(admin, user\.id, id/);
  assert.match(route, /verifyPostAssetStored/);
  assert.match(route, /removePostAssetObject/);
  assert.doesNotMatch(route, /open\.tiktokapis\.com|publish\/video|fetch\([^)]*tiktok/i);
});

test("TikTok editor exposes an MP4 control and keeps posting gated on an attached playable preview", async () => {
  const editor = await read("components/voom/modals/SocialEditorModal.tsx");
  const sheet = await read("components/voom/modals/TikTokPostSheet.tsx");
  assert.match(editor, /type="file"/);
  assert.match(editor, /accept=\{TIKTOK_VIDEO_UPLOAD_ACCEPT\}/);
  assert.match(editor, /Upload MP4/);
  assert.match(editor, /Replace video/);
  assert.match(editor, /disabled=\{busy \|\| uploading \|\| !draft\.asset\}/);
  assert.match(sheet, /onLoadedMetadata/);
  assert.match(sheet, /videoDurationSec/);
  assert.match(sheet, /isTikTokVideoPreviewReady\(previewState, duration\)/);
});
