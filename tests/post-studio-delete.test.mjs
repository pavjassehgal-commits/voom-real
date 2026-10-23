/**
 * Post Studio: "Delete post" and "Cancel approval" from the editor.
 *
 *   1. `deletePostDraft` (REAL helper, fake database) refuses a post Instagram
 *      is publishing or has published, and otherwise removes, in order, the
 *      calendar row, the queue row (cancel), the stored file and its row, and
 *      finally the draft itself.
 *   2. The DELETE route is authenticated, owner-scoped and maps each refusal to
 *      a plain message; the editor has both buttons, a confirm step before
 *      deleting, and reuses the existing "cancel" action for approvals.
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const serverData = await import("../lib/post/server-data.ts");

const OWNER = "owner-1";
const DRAFT = "11111111-1111-4111-8111-111111111111";

/**
 * A minimal fake of the admin client: enough chainable query methods for the
 * helper's reads and writes, recording every write in order.
 */
function fakeAdmin({ draftExists = true, queueStatus = null, asset = null, generationsReferencingFile = 0, draftDeleteError = null } = {}) {
  const log = [];
  const table = (name) => {
    const q = {
      select: (columns, options) => { q._count = Boolean(options?.count); return q; },
      eq: () => q, order: () => q, limit: () => q,
      maybeSingle: async () => {
        if (name === "mara_drafts") return { data: draftExists ? { id: DRAFT } : null, error: null };
        if (name === "instagram_publish_queue") return { data: queueStatus ? { id: "q-1", status: queueStatus } : null, error: null };
        if (name === "content_calendar_items") return { data: { id: "cal-1" }, error: null };
        if (name === "post_draft_assets") return { data: asset, error: null };
        return { data: null, error: null };
      },
      delete: () => {
        log.push(`delete ${name}`);
        const d = { eq: () => d, then: undefined };
        d.eq = () => d;
        // Awaitable like a Supabase query builder.
        d.then = (resolve) => resolve({ error: name === "mara_drafts" ? draftDeleteError : null, data: null });
        return d;
      },
      update: () => { log.push(`update ${name}`); return q; },
    };
    // `select("id", { count: "exact", head: true })` is awaited directly.
    q.then = (resolve) => resolve({ count: name === "mara_media_generations" ? generationsReferencingFile : 0, data: null, error: null });
    return q;
  };
  return {
    log,
    from: (name) => table(name),
    rpc: async (fn) => { log.push(`rpc ${fn}`); return { data: true, error: null }; },
    storage: { from: (bucket) => ({ remove: async (paths) => { log.push(`storage remove ${bucket} ${paths.join(",")}`); return { error: null }; } }) },
  };
}

test("deleting a post removes the calendar row, cancels the queue, removes the file and then the draft", async () => {
  const admin = fakeAdmin({ queueStatus: "scheduled", asset: { storage_path: "posts/owner-1/a.png" } });
  assert.deepEqual(await serverData.deletePostDraft(admin, OWNER, DRAFT), { ok: true });
  assert.deepEqual(admin.log, [
    "delete content_calendar_items",
    "rpc cancel_instagram_publish_queue_item",
    "delete post_draft_assets",
    "storage remove mara-media posts/owner-1/a.png",
    "delete mara_drafts",
  ], "calendar first (restrict foreign key), queue cancelled, file and row removed, draft last");
});

test("a post with no visual deletes without touching storage; an unknown post is not found", async () => {
  const admin = fakeAdmin();
  assert.deepEqual(await serverData.deletePostDraft(admin, OWNER, DRAFT), { ok: true });
  assert.equal(admin.log.some((line) => line.startsWith("storage remove")), false);
  assert.ok(admin.log.includes("delete mara_drafts"));

  const missing = fakeAdmin({ draftExists: false });
  assert.deepEqual(await serverData.deletePostDraft(missing, OWNER, DRAFT), { ok: false, reason: "not_found" });
  assert.deepEqual(missing.log, [], "nothing is written for a post the owner does not have");
});

test("a post Instagram is publishing, or has published, is never deleted", async () => {
  for (const [status, reason] of [["publishing", "publishing"], ["published", "published"]]) {
    const admin = fakeAdmin({ queueStatus: status, asset: { storage_path: "posts/owner-1/a.png" } });
    assert.deepEqual(await serverData.deletePostDraft(admin, OWNER, DRAFT), { ok: false, reason });
    assert.deepEqual(admin.log, [], `${status}: no row, file or queue item is touched`);
  }
});

test("a stored file still referenced by a paid generation record is kept, the draft still goes", async () => {
  const admin = fakeAdmin({ asset: { storage_path: "posts/owner-1/paid.png" }, generationsReferencingFile: 1 });
  assert.deepEqual(await serverData.deletePostDraft(admin, OWNER, DRAFT), { ok: true });
  assert.equal(admin.log.some((line) => line.startsWith("storage remove")), false, "the audit trail never points at a missing file");
  assert.ok(admin.log.includes("delete post_draft_assets"));
  assert.ok(admin.log.includes("delete mara_drafts"));
});

test("a failed draft delete throws so the route can report it", async () => {
  const admin = fakeAdmin({ draftDeleteError: { message: "boom" } });
  await assert.rejects(() => serverData.deletePostDraft(admin, OWNER, DRAFT), /post_delete_failed/);
});

test("the DELETE route is authenticated, owner-scoped and explains every refusal plainly", async () => {
  const route = await read("app/api/posts/[id]/route.ts");
  const handler = route.slice(route.indexOf("export async function DELETE"), route.indexOf("export async function PATCH"));
  assert.match(handler, /getCurrentUser\(\)/);
  assert.match(handler, /status: 401/);
  assert.match(handler, /UUID_RE\.test\(id\)/);
  assert.match(handler, /deletePostDraft\(createAdminClient\(\), user\.id, id\)/, "always scoped to the logged-in owner");
  assert.match(handler, /Instagram is publishing this post right now/);
  assert.match(handler, /This post was published to Instagram, so Voom keeps its record/);
  assert.match(handler, /status: 409/);
  assert.match(handler, /deleted: true/);
});

test("the editor offers Delete post (with a confirm step) and Cancel approval for approved posts", async () => {
  const editor = await read("components/voom/modals/PostEditorModal.tsx");
  assert.match(editor, /Delete post/);
  assert.match(editor, /Delete this post for good\? Its caption, schedule and stored visual are removed\. This cannot be undone\./);
  assert.match(editor, /Yes, delete it/);
  assert.match(editor, /fetch\(endpoint, \{ method: "DELETE" \}\)/, "deletes through the post's own endpoint");
  // The confirm step must come before the request: the DELETE call lives in deletePost(), which only the confirm button triggers.
  assert.match(editor, /onClick=\{\(\) => void deletePost\(\)\}/);
  assert.match(editor, /onClick=\{\(\) => setConfirmDelete\(true\)\}/);
  assert.match(editor, /onChanged\?\.\(\);\s*close\(\);/, "the editor closes and the list refreshes after a delete");
  // Cancel approval reuses the server action that already stops auto-publishing.
  assert.match(editor, /post\.internalState !== "draft" \? \(/);
  assert.match(editor, /JSON\.stringify\(\{ action: "cancel" \}\)/);
  assert.match(editor, /Cancel approval/);
});
