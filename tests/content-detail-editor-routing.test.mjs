import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const { resolveContentDetail } = await import("../lib/voom/content-library-core.ts");
const { isPostDraftKind, isSocialVideoDraftKind } = await import("../lib/post/core.ts");

// Mirrors the real readers: getPostDraft reads any mara_drafts row and coerces
// unknown kinds to instagram_post; getSocialDraft returns null unless the row
// is a TikTok/YouTube kind.
function readers(rowKind, { socialFails = false } = {}) {
  const calls = [];
  return {
    calls,
    social: async (id) => {
      calls.push("social");
      if (socialFails) throw new Error("social_draft_asset_read_failed");
      return isSocialVideoDraftKind(rowKind) ? { id, kind: rowKind, editor: "social" } : null;
    },
    post: async (id) => {
      calls.push("post");
      return { id, kind: isPostDraftKind(rowKind) ? rowKind : "instagram_post", editor: "post" };
    },
  };
}

for (const kind of ["youtube_video", "youtube_short", "tiktok_video"]) {
  test(`Content detail opens a ${kind} draft as a social draft, never as an Instagram post`, async () => {
    const r = readers(kind);
    const found = await resolveContentDetail("d1", r);
    assert.equal(found.post, null);
    assert.equal(found.social.kind, kind);
    assert.deepEqual(r.calls, ["social"], "the kind-agnostic post reader is not consulted");
  });
}

for (const kind of ["instagram_post", "reel", "story"]) {
  test(`Content detail keeps ${kind} drafts on the post editor`, async () => {
    const r = readers(kind);
    const found = await resolveContentDetail("d1", r);
    assert.equal(found.social, null);
    assert.equal(found.post.kind, kind);
  });
}

test("a failed social read rejects instead of falling back to the Instagram editor", async () => {
  const r = readers("youtube_video", { socialFails: true });
  await assert.rejects(resolveContentDetail("d1", r), /social_draft_asset_read_failed/);
  assert.deepEqual(r.calls, ["social"]);
});

test("an unknown or non-owned draft resolves to nothing", async () => {
  const found = await resolveContentDetail("d1", { social: async () => null, post: async () => null });
  assert.equal(found, null);
});

test("the Content detail page routes through the resolver and the social editor", async () => {
  const [page, actions, library] = await Promise.all([
    read("app/app/(shell)/content/[id]/page.tsx"),
    read("components/voom/content/ContentDetailActions.tsx"),
    read("lib/voom/content-library.ts"),
  ]);
  assert.match(page, /resolveContentDetail\(id,/);
  assert.doesNotMatch(page, /const post = await getPostDraft\(/, "no post-first lookup");
  assert.match(page, /if \(!found\) notFound\(\)/);
  assert.match(actions, /editor === "social" \? <SocialEditorModal draftId=\{id\}/);
  assert.match(library, /export function fromSocial[\s\S]*?editor: "social"/);
});

test("Create · Preview and Schedule (/app/studio/[id]) load social drafts before the post reader", async () => {
  const [loader, preview, schedule] = await Promise.all([
    read("lib/voom/create-draft.ts"),
    read("app/app/(shell)/studio/[id]/page.tsx"),
    read("app/app/(shell)/studio/[id]/schedule/page.tsx"),
  ]);
  assert.match(loader, /resolveContentDetail\(id,/);
  assert.doesNotMatch(loader, /const post = await getPostDraft\(/, "no post-first lookup");
  assert.match(loader, /if \(!found\) return null/);
  for (const page of [preview, schedule]) assert.match(page, /loadCreateDraft\(createAdminClient\(\), user\.id, id\)/);
});

test("the Instagram post API refuses to approve, schedule, save or cancel a TikTok/YouTube draft", async () => {
  const route = await read("app/api/posts/[id]/route.ts");
  const patch = route.slice(route.indexOf("export async function PATCH"));
  const guard = patch.indexOf("isSocialVideoDraftKind(row.kind)");
  assert.ok(guard > 0, "PATCH checks the stored draft kind");
  assert.match(patch, /select\("kind"\)\s*\.eq\("owner_user_id", user\.id\)\.eq\("id", id\)/);
  assert.match(patch, /if \(kindError\) return Response\.json\([^)]*\{ status: 503 \}\)/, "an unreadable kind fails closed");
  for (const action of ['action === "approve"', 'action === "reject"', "savePostDraft("]) {
    assert.ok(patch.indexOf(action) > guard, `${action} runs only after the kind guard`);
  }
  assert.ok(isSocialVideoDraftKind("youtube_video") && isSocialVideoDraftKind("youtube_short") && isSocialVideoDraftKind("tiktok_video"));
  for (const kind of ["instagram_post", "reel", "story"]) assert.equal(isSocialVideoDraftKind(kind), false, kind);
});
