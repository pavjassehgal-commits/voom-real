import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("campaign screens never claim a send and clearly separate Draft / Approved / Not approved", async () => {
  const [page, modal, notes] = await Promise.all([
    read("app/app/(shell)/campaigns/page.tsx"),
    read("components/voom/modals/CampaignEditorModal.tsx"),
    read("components/voom/ui/Notes.tsx"),
  ]);
  assert.match(page, /CampaignEditorModal/);
  assert.match(page, /No provider connected — Voom has not sent anything/);
  assert.match(page, /Approved — ready for provider/);
  assert.match(page, /Ready to send — provider required/);
  assert.match(page, /never records a campaign as Sent without provider confirmation/);
  assert.match(modal, /Ready to send — provider required/);
  assert.match(modal, /Save draft/);
  assert.match(modal, /Approve for send/);
  assert.match(modal, /Nothing leaves Voom/);
  assert.match(modal, /Voom will never mark it <b>Sent<\/b>/);
  assert.match(notes, /Prototype demonstration/);
  assert.doesNotMatch(page + modal, />Send now</);
  assert.doesNotMatch(page + modal, />Send test</);
  assert.doesNotMatch(page + modal, /Review & send/);
  assert.doesNotMatch(page + modal, /simulates the campaign|sends are simulated/i);
  assert.doesNotMatch(page + modal, />Report</);
});

test("campaign drafts are persisted, owner-scoped, and only move to approved or rejected internally", async () => {
  const [data, listRoute, itemRoute, migration, workflow] = await Promise.all([
    read("lib/mara/internal-data.ts"),
    read("app/api/voom/campaigns/route.ts"),
    read("app/api/voom/campaigns/[id]/route.ts"),
    read("supabase/migrations/0003_mara_internal_tools.sql"),
    read("lib/mara/plan-workflow.ts"),
  ]);
  assert.match(data, /insert\(\{ \.\.\.input, owner_user_id: ownerId, status: "draft" \}\)/);
  assert.match(data, /update\(\{ \.\.\.input, status: "draft" \}\)/);
  assert.match(data, /approveCampaign/);
  assert.match(data, /rejectCampaign/);
  assert.match(data, /update\(\{ status: "approved" \}\)/);
  assert.match(data, /update\(\{ status: "rejected" \}\)/);
  assert.doesNotMatch(data, /"sent"|'sent'/i);
  assert.match(listRoute, /export async function POST/);
  assert.match(listRoute, /createCampaign\(/);
  assert.match(listRoute, /z\.object/);
  assert.match(itemRoute, /export async function PATCH/);
  assert.match(itemRoute, /export async function POST/);
  assert.match(itemRoute, /z\.enum\(\["approve", "reject"\]\)/);
  assert.doesNotMatch(itemRoute, /simulate/);
  assert.doesNotMatch(itemRoute, /"sent"/i);
  assert.match(itemRoute, /nothing has been sent/i);
  assert.match(migration, /status in \('draft', 'approved', 'rejected'\)/);
  assert.doesNotMatch(migration, /\b'sent'\b/);
  assert.match(migration, /grant select, insert, update on table public\.voom_campaigns to authenticated/);
  assert.doesNotMatch(migration, /grant[^;]*delete[^;]*voom_campaigns/);
  assert.match(workflow, /create_campaign_draft/);
  assert.match(workflow, /marketing-plan:\$\{planId\}:campaign:\$\{index\}/);
  assert.match(workflow, /Campaigns are never sent/);
});

test("MARA plan workflow persists email/SMS campaign drafts without sending them", async () => {
  const [workflow, page, workspace] = await Promise.all([
    read("lib/mara/plan-workflow.ts"),
    read("app/app/(shell)/campaigns/page.tsx"),
    read("components/voom/operating/PlanWorkspace.tsx"),
  ]);
  assert.match(workflow, /campaignIds/);
  assert.match(workflow, /const kind = campaign\.channel/);
  assert.match(workflow, /"email" : null/);
  assert.doesNotMatch(workflow, /send_campaign|send_email|send_sms|spend/);
  assert.match(page, /generate a marketing plan so Voom can prepare campaign drafts/);
  assert.match(workspace, /email\/SMS campaign draft/);
  assert.match(workspace, /nothing has been sent/);
});

test("new calendar posts are persisted instead of only mutating demo state", async () => {
  const [route, modal, page] = await Promise.all([
    read("app/api/voom/calendar/route.ts"),
    read("components/voom/modals/ComposeModal.tsx"),
    read("app/app/(shell)/calendar/page.tsx"),
  ]);
  assert.match(route, /export async function POST/);
  assert.match(route, /createCalendarItem\(await createClient\(\), user\.id/);
  assert.match(modal, /fetch\("\/api\/voom\/calendar"/);
  assert.match(modal, /method: "POST"/);
  assert.match(modal, /voom:data-changed/);
  assert.match(modal, /nothing published externally/);
  assert.doesNotMatch(modal, /addPost/);
  assert.match(page, /New posts and MARA-approved items are saved in Voom/);
});

test("legacy sample workspaces and notifications never claim external actions happened", async () => {
  const [reels, store, notifications, reelsModalCopy] = await Promise.all([
    read("app/app/(shell)/reels/page.tsx"),
    read("lib/voom/store.tsx"),
    read("components/voom/modals/NotificationsModal.tsx"),
    read("components/voom/modals/PostDetailModal.tsx"),
  ]);
  assert.match(reels, /sample workspace/);
  assert.match(reels, /Open real Reel workflow/);
  assert.match(reels, /illustration-only/);
  assert.doesNotMatch(store, /Reel scheduled for Aug 25/);
  assert.doesNotMatch(store, /Whole queue moved to best slot/);
  assert.match(store, /sample/i);
  assert.match(notifications, /Nothing has been sent/);
  assert.doesNotMatch(notifications, /" sent",/);
  assert.match(notifications, /Sample: email draft prepared/);
  assert.match(reelsModalCopy, /Sample/);
  assert.match(reelsModalCopy, /not saved in Voom/);
});
