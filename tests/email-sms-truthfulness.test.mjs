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
  assert.match(page, /Delivery status stays truthful — Voom never fabricates a send/);
  assert.match(page, /Approved — ready to send/);
  assert.match(page, /Ready — open campaign to send/);
  assert.match(page, /never records a campaign as Delivered without provider confirmation/);
  assert.match(modal, /Send approved/);
  assert.match(modal, /Save draft/);
  assert.match(modal, /Approve for send/);
  assert.match(modal, /Only the explicit Send action can contact a real recipient/);
  assert.match(modal, /Voom will never mark it <b>Delivered<\/b>/);
  // Demo shims are gone; the only note left is the honest ad-separation note.
  assert.match(notes, /Advertising budgets are optional/);
  assert.doesNotMatch(notes, /Prototype demonstration|DemoTag|ExTag|ProtoNote/);
  assert.doesNotMatch(page, /Sample subscribers|Sample open rate|Sample SMS opt-ins|DemoTag/);
  assert.doesNotMatch(page + modal, />Send now</);
  assert.doesNotMatch(page + modal, />Send test</);
  assert.doesNotMatch(page + modal, /Review & send/);
  assert.doesNotMatch(page + modal, /simulates the campaign|sends are simulated/i);
  assert.doesNotMatch(page + modal, />Report</);
});

test("campaign drafts are persisted, owner-scoped, and only move to approved or rejected internally", async () => {
  const [data, listRoute, itemRoute, migration] = await Promise.all([
    read("lib/mara/internal-data.ts"),
    read("app/api/voom/campaigns/route.ts"),
    read("app/api/voom/campaigns/[id]/route.ts"),
    read("supabase/migrations/0003_mara_internal_tools.sql"),
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
});

test("email/SMS campaign drafts stay a separate, send-free surface", async () => {
  const [workflow, page, workspace] = await Promise.all([
    read("lib/voom/workflow/service.ts"),
    read("app/app/(shell)/campaigns/page.tsx"),
    read("components/voom/operating/PlanWorkspace.tsx"),
  ]);
  // The content workflow never sends or schedules an email campaign, and
  // the Marketing Plan only renders executable content items.
  assert.doesNotMatch(workflow, /send_campaign|send_email|send_sms|spend/);
  assert.doesNotMatch(workspace, /send|Send/);
  // The empty state explains purpose + next actions without inventing data.
  assert.match(page, /EmptyState/);
  assert.match(page, /it will build the full Instagram and email sequence for you to approve/);
});

test("content creation goes through the real persisted workflow, not a demo composer", async () => {
  const [route, create, page] = await Promise.all([
    read("app/api/voom/calendar/route.ts"),
    read("components/voom/modals/CreateContentModal.tsx"),
    read("app/app/(shell)/calendar/page.tsx"),
  ]);
  assert.match(route, /export async function POST/);
  assert.match(route, /createCalendarItem\(await createClient\(\), user\.id/);
  assert.match(create, /fetch\("\/api\/posts"/);
  assert.match(create, /method: "POST"/);
  // Multi-Social Core: the modal now names every platform, so the truth line
  // widened from "Nothing is published to Instagram" to all platforms.
  assert.match(create, /Nothing is published to any platform/);
  // The demo compose modal was deleted; the calendar only offers the real
  // create modal and renders only real workflow items.
  let composeMissing = false;
  try { await read("components/voom/modals/ComposeModal.tsx"); } catch { composeMissing = true; }
  assert.equal(composeMissing, true, "ComposeModal.tsx must not exist in production");
  assert.match(page, /CreateContentModal/);
  assert.doesNotMatch(page, /ComposeModal|Sample|illustration-only|isAug/);
  // The calendar POST endpoint rejects scheduling in the past.
  assert.match(route, /checkScheduleInstant/);
});

test("sample workspaces are deleted and notifications are real workflow facts", async () => {
  const [reels, store, notifications] = await Promise.all([
    read("app/app/(shell)/reels/page.tsx"),
    read("lib/voom/store.tsx"),
    read("components/voom/modals/NotificationsModal.tsx"),
  ]);
  // /app/reels is a redirect; the sample studio and detail modal are deleted.
  assert.match(reels, /redirect\("\/app\/studio"\)/);
  for (const gone of ["components/voom/modals/PostDetailModal.tsx", "components/voom/mara/LegacyMaraChat.tsx"]) {
    let missing = false;
    try { await read(gone); } catch { missing = true; }
    assert.equal(missing, true, `${gone} must not exist in production`);
  }
  // The store seeds nothing from sample data.
  assert.doesNotMatch(store, /buildPosts|buildReelQueue|buildAdAlloc|buildInsights|seedChatFor|notif: 3/);
  // Notifications are derived from the real workflow read model.
  assert.match(notifications, /\/api\/voom\/workflow/);
  assert.match(notifications, /You’re all caught up/);
  assert.doesNotMatch(notifications, /Sample:/);
});
