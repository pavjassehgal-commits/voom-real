import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("MARA chat is preserved but removed from navigation and redirected", async () => {
  const [nav, route, legacy] = await Promise.all([read("components/voom/shell/nav.ts"), read("app/app/(shell)/mara/page.tsx"), read("components/voom/mara/LegacyMaraChat.tsx")]);
  assert.doesNotMatch(nav, /n: "MARA"/);
  assert.match(route, /redirect\("\/app\/today"\)/);
  assert.match(legacy, /LegacyMaraChat/);
  assert.match(legacy, /fetch\("\/api\/mara"/);
  assert.match(legacy, /pendingActions/);
});

test("marketing plans are owner-scoped, anonymous-blocked, and server-written", async () => {
  const migration = await read("supabase/migrations/0009_marketing_plans.sql");
  assert.match(migration, /^begin;/m); assert.match(migration, /^commit;/m);
  assert.match(migration, /alter table public\.marketing_plans enable row level security/);
  assert.match(migration, /revoke all on table public\.marketing_plans from anon, authenticated/);
  assert.match(migration, /grant select on table public\.marketing_plans to authenticated/);
  assert.match(migration, /grant select, insert, update on table public\.marketing_plans to service_role/);
  assert.match(migration, /auth\.uid\(\)\) = owner_user_id/);
  assert.doesNotMatch(migration, /grant .*insert.*authenticated/);
});

test("planning is server-only, structured, grounded, and never creates chat messages", async () => {
  const [service, route] = await Promise.all([read("lib/mara/planning.ts"), read("app/api/plan/route.ts")]);
  assert.match(service, /import "server-only"/);
  assert.match(service, /provider\.structured/);
  for (const source of ["getBrandProfile", "listCalendarItems", "listCampaigns", "getInstagramConnection", "instagram_insight_snapshots"]) assert.match(service, new RegExp(source));
  assert.doesNotMatch(service + route, /from\("mara_messages"\).*insert/s);
  assert.match(route, /getCurrentUser/);
  assert.match(route, /owner_user_id: user\.id/);
});

test("automation modes preserve confirmation safety", async () => {
  const [route, page] = await Promise.all([read("app/api/automation-mode/route.ts"), read("app/app/(shell)/automations/page.tsx")]);
  for (const mode of ["manual", "assisted", "autopilot"]) assert.match(route, new RegExp(`"${mode}"`));
  assert.match(page, /No mode can publish externally, send a campaign, delete content, or spend advertising money/);
  assert.match(route, /externalActionsRequirePermission: true/);
});

test("Today summarizes real owner-scoped weekly workflow data without side effects", async () => {
  const [page, data] = await Promise.all([read("app/app/(shell)/today/page.tsx"), read("lib/voom/operating-data.ts")]);
  for (const section of ["Needs your approval", "Next scheduled content", "Marketing plan", "Voom recommendation"]) assert.match(page, new RegExp(section));
  assert.match(data, /mara_pending_actions/);
  assert.match(data, /content_calendar_items/);
  assert.match(data, /marketing_plans/);
  assert.match(data, /eq\("owner_user_id", user\.id\)/);
  assert.match(data, /eq\("tool_name", "propose_calendar_item"\)/);
  assert.match(data, /in\("status", \["approved", "scheduled"\]\)/);
  assert.match(page, /timeZone: "Asia\/Dubai"/);
  assert.match(page, /No marketing plan yet/);
  assert.match(page, /Nothing scheduled yet/);
  assert.doesNotMatch(page + data, /fetch\(|provider\.|prepareInstagramPlanWorkflow|insert\(|upsert\(|update\(/);
});

test("plan generation persists exactly three distinct Instagram drafts and approvals without chat messages", async () => {
  const [planning, workflow, route, migration, workspace] = await Promise.all([
    read("lib/mara/planning.ts"), read("lib/mara/plan-workflow.ts"), read("app/api/plan/route.ts"),
    read("supabase/migrations/0013_weekly_plan_recommendations.sql"), read("components/voom/operating/PlanWorkspace.tsx"),
  ]);
  assert.match(planning, /complete caption with CTA and hashtags/);
  assert.match(planning, /proposedPublishAt/);
  assert.match(planning, /plannedPosts: z\.array\(plannedPost\)\.length\(3\)/);
  assert.match(planning, /distinct topics/);
  assert.match(planning, /Schedule each recommendation on a different day/);
  assert.match(planning, /time > latest/);
  assert.match(workflow, /posts\.length !== 3/);
  assert.match(workflow, /mara_drafts"\)\.upsert\(draftRows/);
  assert.match(workflow, /source_plan_id: planId/);
  assert.match(workflow, /source_plan_item_key: String\(index\)/);
  assert.match(workflow, /Promise\.all\(posts\.map/);
  assert.match(workflow, /"propose_calendar_item"/);
  assert.match(workflow, /marketing-plan:\$\{planId\}:item:\$\{index\}/);
  assert.match(workflow, /pendingActionIds/);
  assert.doesNotMatch(workflow, /mara_messages/);
  assert.match(route, /prepareInstagramPlanWorkflow/);
  assert.match(migration, /unique \(owner_user_id, source_plan_id, source_plan_item_key\)/);
  assert.match(workspace, /Your 3 Instagram recommendations are ready/);
});

test("approved plan content is independently and idempotently linked to the calendar and never published", async () => {
  const [migration, weeklyMigration, ownerLinks, tools, data] = await Promise.all([
    read("supabase/migrations/0010_plan_to_calendar_workflow.sql"), read("supabase/migrations/0013_weekly_plan_recommendations.sql"),
    read("supabase/migrations/0011_plan_workflow_owner_links.sql"), read("lib/mara/tools.ts"), read("lib/mara/internal-data.ts"),
  ]);
  assert.match(weeklyMigration, /drop constraint if exists mara_drafts_owner_source_plan_key/);
  assert.match(weeklyMigration, /unique \(owner_user_id, source_plan_id, source_plan_item_key\)/);
  assert.match(migration, /unique \(owner_user_id, source_draft_id\)/);
  assert.match(ownerLinks, /foreign key \(source_plan_id, owner_user_id\)/);
  assert.match(ownerLinks, /foreign key \(source_draft_id, owner_user_id\)/);
  assert.match(data, /onConflict: "owner_user_id,source_draft_id"/);
  assert.match(tools, /status: "approved"/);
  assert.match(tools, /Nothing was published/);
  assert.match(tools, /mara_drafts"\)\.update\(\{ status: "approved" \}\)/);
});

test("approval edits persist atomically and confirmation uses the latest owned draft", async () => {
  const [board, route, migration, tools] = await Promise.all([
    read("components/voom/operating/ApprovalsBoard.tsx"), read("app/api/mara/actions/[id]/route.ts"),
    read("supabase/migrations/0012_edit_plan_calendar_approval.sql"), read("lib/mara/tools.ts"),
  ]);
  assert.match(board, /Instagram caption/);
  assert.match(board, /type="datetime-local"/);
  assert.match(route, /edit_mara_calendar_approval/);
  assert.match(migration, /security invoker/);
  assert.match(migration, /owner_user_id = v_owner_id/);
  assert.match(migration, /update public\.mara_drafts/);
  assert.match(migration, /update public\.mara_pending_actions/);
  assert.match(tools, /draft\?\.content \?\? a\.content/);
  assert.match(tools, /draft\?\.proposed_publish_at \?\? a\.publishAt/);
});

test("saved calendar details are read-only, current, sanitized, and owner-scoped", async () => {
  const [page, modal, route, data, migration] = await Promise.all([
    read("app/app/(shell)/calendar/page.tsx"), read("components/voom/modals/SavedCalendarDetailModal.tsx"),
    read("app/api/voom/calendar/[id]/route.ts"), read("lib/mara/internal-data.ts"), read("supabase/migrations/0003_mara_internal_tools.sql"),
  ]);
  assert.match(page, /SavedCalendarDetailModal/);
  assert.match(modal, /Final caption \/ content/);
  assert.match(modal, /Nothing has been published or sent externally/);
  assert.doesNotMatch(modal, /Textarea|>Publish<|>Send</);
  assert.match(route, /getCurrentUser/);
  assert.match(route, /getCalendarItem\(await createClient\(\), user\.id, id\)/);
  assert.match(route, /source: item\.source_draft_id \? "MARA recommendation · approved in Voom" : null/);
  assert.doesNotMatch(route, /owner_user_id:|source_draft_id:/);
  assert.match(data, /eq\("owner_user_id", ownerId\)\.eq\("id", id\)/);
  assert.match(migration, /create policy "calendar_items_own"[\s\S]*auth\.uid\(\)\) = owner_user_id/);
});
