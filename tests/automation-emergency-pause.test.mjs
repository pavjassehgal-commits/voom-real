import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const automation = await import("../lib/voom/automation.ts");

test("mode downgrade changes only future automation and preserves approved work", () => {
  const effect = automation.automationModeChangeEffect("autopilot", "manual");
  assert.equal(effect.futureAutomationEnabled, false);
  assert.equal(effect.futureAutoApproval, false);
  assert.equal(effect.cancelsExistingSchedules, false);
  assert.equal(effect.revokesExistingApprovals, false);
  assert.equal(effect.deletesExistingMedia, false);
});

test("mode PATCH enforces the saved subscription entitlement server-side", async () => {
  const route = await read("app/api/automation-mode/route.ts");
  assert.match(route, /select\("automation_level,plan"\)/);
  assert.match(route, /canUseAutomationMode\(plan, parsed\.data\.mode\)/);
  assert.match(route, /status: 403/);
});

test("pause endpoint is authenticated, owner-scoped and idempotent", async () => {
  const route = await read("app/api/automation/pause/route.ts");
  assert.match(route, /getCurrentUser\(\)/);
  assert.match(route, /pauseAllAutomation\(createAdminClient\(\), user\.id/);
  assert.match(route, /idempotencyKey: z\.string\(\)\.min\(16\)\.max\(200\)/);
});

test("migration stops only fresh autopilot jobs on all social queues", async () => {
  const sql = await read("supabase/migrations/0059_automation_emergency_pause.sql");
  for (const table of ["instagram_publish_queue", "youtube_publish_queue", "tiktok_publish_queue"]) {
    assert.match(sql, new RegExp(`update public\\.${table} q set status = 'cancelled'`));
    assert.match(sql, new RegExp(`create trigger ${table.replace("_publish_queue", "")}_paused_automation_claim_guard`));
  }
  assert.match(sql, /d\.approval_origin = 'autopilot'/);
  assert.match(sql, /q\.container_id is null/);
  assert.match(sql, /q\.upload_session_url is null/);
  assert.match(sql, /q\.tiktok_publish_id is null/);
  assert.match(sql, /return null/);
});

test("pause preserves manual approvals and reports in-flight and published work", async () => {
  const sql = await read("supabase/migrations/0059_automation_emergency_pause.sql");
  assert.match(sql, /approval_origin text not null default 'user'/);
  assert.doesNotMatch(sql, /status in \('scheduled', 'waiting_for_media'\)[^;]+approval_origin\s*=\s*'user'/s);
  assert.match(sql, /'claimedOrSubmitted',v_inflight/);
  assert.match(sql, /'published',v_published/);
  assert.match(sql, /status = 'paused', paused_at = now\(\)/);
});

test("database permissions and owner isolation fail closed", async () => {
  const sql = await read("supabase/migrations/0059_automation_emergency_pause.sql");
  assert.match(sql, /enable row level security/);
  assert.match(sql, /auth\.uid\(\)\) = owner_user_id/);
  assert.match(sql, /revoke all on function public\.pause_all_automation\(uuid,text\) from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.pause_all_automation\(uuid,text\) to service_role/);
  assert.match(sql, /where owner_user_id = p_owner_user_id for update/);
});

test("scheduled planning, paid media and internal approval all re-check pause/mode", async () => {
  const workflow = await read("lib/voom/workflow/service.ts");
  const media = await read("lib/voom/workflow/media.ts");
  const fleet = await read("lib/coordinator/service.ts");
  assert.match(workflow, /trigger === "scheduled"[\s\S]*automation_paused_at[\s\S]*throw new Error\("automation_paused"\)/);
  assert.equal((workflow.match(/assertAutonomousWorkAllowed\(admin, context\.ownerId\)/g) ?? []).length, 2);
  assert.match(workflow, /approveWorkflowItem\(admin, context\.ownerId, item\.draftId, "autopilot", item\.contentVersion\)/);
  assert.match(media, /final boundary immediately before either paid provider/);
  assert.match(media, /assertAutonomousWorkAllowed\(admin, request\.ownerId\)[\s\S]*releaseReservationOnFailure/);
  assert.match(fleet, /\.is\("automation_paused_at", null\)/);
});
