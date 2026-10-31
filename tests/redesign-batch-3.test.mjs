import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Approvals: a 409 replaces the stale card with the server's refreshed one and keeps the reason visible", async () => {
  const board = await read("components/voom/operating/ApprovalsBoard.tsx");
  assert.match(board, /fetch\(`\/api\/mara\/actions\/\$\{id\}`/, "decisions use the existing route");
  assert.match(board, /if \(body\.action\) \{ const action = body\.action; setItems/, "a returned action always replaces the card");
  assert.match(board, /response\.status === 409/, "conflicts are handled explicitly");
  assert.match(board, /router\.refresh\(\)/, "the owner can refresh to reload media and status");
});

test("Approvals: Confirm is blocked while the post's media is unfinished", async () => {
  const board = await read("components/voom/operating/ApprovalsBoard.tsx");
  assert.match(board, /disabled=\{busy \|\| Boolean\(confirmBlockedReason\)\}/);
  assert.match(board, /selectedDraft && !selectedDraft\.hasMedia/, "the block comes from the draft's real media state");
  assert.match(board, /Awaiting media/);
  assert.match(board, /failed \? "Retry" : "Confirm"/, "failed actions keep the real retry");
  assert.match(board, /Autopilot approved/, "Autopilot's own approvals stay distinguishable");
  const page = await read("app/app/(shell)/approvals/page.tsx");
  assert.match(page, /data\.snapshot\.items/, "draft media facts come from the shared workflow snapshot");
});

test("Automations: pause and resume use the existing routes, with confirmation and idempotency", async () => {
  const control = await read("components/voom/automations/AutomationPauseControl.tsx");
  assert.match(control, /fetch\(`\/api\/automation\/\$\{kind\}`/);
  assert.match(control, /idempotencyKey: crypto\.randomUUID\(\), confirm: true/, "resume sends the explicit confirmation the route requires");
  assert.match(control, /Resume automation\?/, "resuming asks first");
  assert.match(control, /Pause all automation\?/, "pausing asks first");
  assert.match(control, /are <b className="text-text">not<\/b> restored/, "resume never claims to restore cancelled work");
  const state = await read("lib/voom/automation-pause-state.ts");
  assert.match(state, /^import "server-only";/m);
  assert.doesNotMatch(state, /\.(update|insert|upsert|delete)\(/, "the pause state is read-only here");
});

test("Automations: switching mode is never described as cancelling scheduled content", async () => {
  const page = await read("app/app/(shell)/automations/page.tsx");
  assert.match(page, /doesn’t cancel posts that are already approved and scheduled/);
  assert.doesNotMatch(page, /Manual[^.]{0,80}cancels/i);
  assert.match(page, /href="\/app\/pricing"/, "a plan-locked mode offers the plans page");
});

test("MARA overview is read-only and never recreates the retired chat or invented metrics", async () => {
  const [page, view] = await Promise.all([read("app/app/(shell)/mara/page.tsx"), read("components/voom/mara/MaraOverview.tsx")]);
  const all = page + view;
  assert.match(page, /getOperatingData\(\)/);
  assert.match(page, /getCreditSummary/, "credits come from the real ledger");
  assert.doesNotMatch(all, /fetch\(|<input|<textarea|Ask MARA anything|Chat with MARA/i);
  assert.doesNotMatch(all, /Time saved|Accepted suggestions|vs last week|Ad spend · needs approval/i);
});
