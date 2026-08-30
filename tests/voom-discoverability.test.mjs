import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Marketing Plan clearly labels Reel recommendations and links to the real Approvals workflow", async () => {
  const [workspace, board, reels] = await Promise.all([
    read("components/voom/operating/PlanWorkspace.tsx"),
    read("components/voom/operating/ApprovalsBoard.tsx"),
    read("app/app/(shell)/reels/page.tsx"),
  ]);
  assert.match(workspace, /MARA only recommends a/);
  assert.match(workspace, /Reel<\/Tag>/);
  assert.match(workspace, /Production choice needed/);
  assert.match(workspace, /No Reel recommendation in this plan/);
  assert.match(workspace, /Refresh the plan to get a new mix/);
  assert.match(board, /Reel production choices live here too/);
  assert.match(board, /Create with MARA/);
  assert.match(board, /Generate or refresh your Marketing Plan/);
  assert.match(reels, /The real MARA Reel workflow/);
  assert.match(reels, /Marketing Plan → Generate\/Refresh plan → Approvals/);
  assert.match(reels, /Review marketing plan/);
  assert.match(reels, /Open real Reel workflow/);
  assert.doesNotMatch(reels + workspace + board, /generateVideo|mara_media_generations|instagram_publish_jobs/);
});

test("Reel production choices remain plan-driven and never fake production", async () => {
  const [workflow, planning, tools, produce] = await Promise.all([
    read("lib/mara/plan-workflow.ts"),
    read("lib/mara/planning.ts"),
    read("lib/mara/tools.ts"),
    read("app/api/reels/produce/[actionId]/route.ts"),
  ]);
  assert.match(workflow, /post\.contentType === "reel"/);
  assert.match(planning, /contentType: z\.enum\(\["feed", "reel"\]\)/);
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
