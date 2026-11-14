/**
 * Post Studio: an Instagram Post's source can be switched between "My own
 * asset" and "Existing content" in the editor, which is what unlocks MARA's
 * caption, CTA and timing suggestions for a photo the user already shot.
 * Before this, the create dialog promised a switch that did not exist.
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

function fakeAdmin({ asset = null } = {}) {
  const updates = [];
  return {
    updates,
    from: (name) => {
      const q = {
        select: () => q, eq: () => q, order: () => q, limit: () => q,
        maybeSingle: async () => ({ data: name === "post_draft_assets" ? asset : null, error: null }),
        update: (payload) => { updates.push({ table: name, payload }); return q; },
        then: (resolve) => resolve({ error: null, data: null }),
      };
      return q;
    },
  };
}

test("switching the source rewrites the stored visual's origin with the production value", async () => {
  const admin = fakeAdmin({ asset: { id: "a-1", origin: "uploaded_asset", storage_path: "posts/owner-1/a.png" } });
  assert.equal(await serverData.setPostAssetOrigin(admin, OWNER, DRAFT, "existing_content"), true);
  assert.deepEqual(admin.updates, [{ table: "post_draft_assets", payload: { origin: "uploaded_existing" } }]);

  const back = fakeAdmin({ asset: { id: "a-1", origin: "uploaded_existing", storage_path: "posts/owner-1/a.png" } });
  assert.equal(await serverData.setPostAssetOrigin(back, OWNER, DRAFT, "own_asset"), true);
  assert.deepEqual(back.updates, [{ table: "post_draft_assets", payload: { origin: "uploaded_asset" } }]);
});

test("with no visual yet there is nothing to rewrite; the choice applies to the next upload", async () => {
  const admin = fakeAdmin();
  assert.equal(await serverData.setPostAssetOrigin(admin, OWNER, DRAFT, "existing_content"), false);
  assert.deepEqual(admin.updates, []);
});

test("the source action is Instagram-Post-only, validated and owner-scoped", async () => {
  const route = await read("app/api/posts/[id]/route.ts");
  const branch = route.slice(route.indexOf('if (action === "source")'), route.indexOf('if (action !== "save")'));
  assert.match(branch, /origin !== "own_asset" && origin !== "existing_content"/, "only the two real sources are accepted");
  assert.match(branch, /existing\.kind !== "instagram_post"/, "Reels and Stories keep their fixed source");
  assert.match(branch, /setPostAssetOrigin\(admin, user\.id, id, origin\)/);
  assert.match(branch, /MARA can now suggest a caption, CTA and timing/);
  assert.match(branch, /It applies to the visual you upload next/);
});

test("the editor shows the Source switch for Instagram Posts and sends the choice with uploads", async () => {
  const editor = await read("components/voom/modals/PostEditorModal.tsx");
  assert.match(editor, /<h3[^>]*>Source<\/h3>/);
  assert.match(editor, /\{isPost \? \(\s*<div className="mt-3\.5">\s*<h3[^>]*>Source<\/h3>/, "the switch exists only for Instagram Posts");
  assert.match(editor, /chooseSource\("own_asset"\)/);
  assert.match(editor, /chooseSource\("existing_content"\)/);
  assert.match(editor, /JSON\.stringify\(\{ action: "source", origin: value \}\)/, "with a visual, the switch is saved on the server");
  assert.match(editor, /uploadFile\(file, post\.kind === "reel" \|\| post\.kind === "story" \? "existing_content" : source\)/, "the next upload carries the chosen source");
  assert.match(editor, /if \(view\.origin === "existing_content" \|\| view\.origin === "own_asset"\) setSource\(view\.origin\)/, "the switch reflects the stored source when a post loads");
  // The suggestion button still keys off the stored source, so switching unlocks it.
  assert.match(editor, /post\.origin === "existing_content" && !isStory \? \(/);
});

test("the create dialog now describes a switch that exists, in the editor's own words", async () => {
  const dialog = await read("components/voom/modals/CreateContentModal.tsx");
  assert.match(dialog, /pick <b>Existing content<\/b> under\s+Source in the editor/);
  assert.doesNotMatch(dialog, /switch the source to/, "the old wording promised a control that did not exist");
});
