import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Marketing Plan clearly labels Reel recommendations and links to the real Approvals workflow", async () => {
  const [workspace, itemCard, board, create, reelsRoute] = await Promise.all([
    read("components/voom/operating/PlanWorkspace.tsx"),
    read("components/voom/operating/PlanItemCard.tsx"),
    read("components/voom/operating/ApprovalsBoard.tsx"),
    read("components/voom/modals/CreateContentModal.tsx"),
    read("app/app/(shell)/reels/page.tsx"),
  ]);
  // The Marketing Plan renders the real rolling horizon, with each item's own
  // content type, and links into the same Approvals / Calendar workflow.
  // The per-item card derives its content-type label from the shared view.
  assert.match(workspace + itemCard, /contentTypeLabel/);
  assert.match(workspace, /Posting frequency/);
  assert.match(workspace, /\/app\/approvals/);
  assert.match(workspace, /\/app\/calendar/);
  assert.match(board, /Reel production choices live here too/);
  assert.match(board, /Create with MARA/);
  assert.match(board, /Generate or refresh your Marketing Plan/);
  // The sample Reel studio is gone: /app/reels forwards to the real Create
  // Content studio, and the create flow points at the real Approvals workflow.
  assert.match(reelsRoute, /redirect\("\/app\/studio"\)/);
  assert.match(create, /existing Reel workflow/);
  assert.match(create, /\/app\/approvals/);
  assert.doesNotMatch(reelsRoute + workspace + board, /generateVideo|mara_media_generations|instagram_publish_jobs/);
});

test("Reel production choices remain plan-driven and never fake production", async () => {
  const [workflow, planning, tools, produce] = await Promise.all([
    read("lib/voom/workflow/service.ts"),
    read("lib/voom/cadence.ts"),
    read("lib/mara/tools.ts"),
    read("app/api/reels/produce/[actionId]/route.ts"),
  ]);
  assert.match(workflow, /draftKindForContentType/);
  assert.match(planning, /CONTENT_TYPES = \["post", "reel", "story"\]/);
  assert.match(tools, /classifyReelProduction/);
  assert.match(produce, /productionStatus: "produced"/);
  assert.match(produce, /Nothing was published/);
  assert.doesNotMatch(workflow + planning, /fake|sample production|simulate video/i);
});

test("Instagram OAuth has no hardcoded account selection or stored-account pick", async () => {
  const [client, data, saveRpc, connectRoute, callback] = await Promise.all([
    read("lib/instagram/client.ts"),
    read("lib/instagram/data.ts"),
    read("supabase/migrations/0004_instagram_integration.sql"),
    read("app/api/integrations/instagram/connect/route.ts"),
    read("app/api/integrations/instagram/callback/route.ts"),
  ]);
  assert.match(client, /instagram\.com\/oauth\/authorize/);
  assert.match(client, /INSTAGRAM_SCOPES/);
  assert.match(client, /authorizationUrl/);
  assert.doesNotMatch(client, /account_id|ig_user_id|username\s*=|vibebling/i);
  assert.match(data, /createOAuthState/);
  assert.match(data, /randomBytes\(32\)/);
  assert.match(data, /save_instagram_connection/);
  assert.match(saveRpc, /on conflict \(owner_user_id\) do update/);
  assert.match(saveRpc, /where owner_user_id = p_owner_user_id/);
  assert.match(connectRoute, /requireInstagramConfig/);
  assert.match(connectRoute, /createOAuthState/);
  assert.match(callback, /consumeOAuthState/);
  assert.match(callback, /saveInstagramConnection/);
  assert.doesNotMatch(client + data + connectRoute + callback, /NEXT_PUBLIC.*(TOKEN|SECRET|KEY)/);
});
