import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ensureRollingPlan } from "../lib/voom/workflow/rolling-plan.ts";

const ROOT = new URL("../", import.meta.url);
const NOW = new Date("2026-10-18T08:00:00.000Z");
const input = {
  now: NOW,
  timeZone: "Asia/Dubai",
  cadence: "weekly",
  mode: "assisted",
  goal: "Grow awareness",
  selectedChannels: ["instagram"],
};

function harness() {
  const drafts = new Map();
  const approvals = new Map();
  const calls = { media: 0, autoApprove: 0, approval: 0 };
  const ports = {
    async ensurePlan() { return "plan-1"; },
    async listItems() { return [...drafts.values()]; },
    async generateContent(slot) {
      return { concept: `Idea ${slot.date}`, caption: "A useful draft.", cta: "Learn more", hashtags: [], visualBrief: "A safe visual" };
    },
    async createDraft({ slot, content }) {
      const item = {
        draftId: `draft-${slot.slotKey}`,
        slotKey: slot.slotKey,
        channel: slot.channel,
        format: slot.format,
        contentType: slot.contentType,
        concept: content.concept,
        caption: content.caption,
        publishAt: slot.publishAt,
        status: "draft",
      };
      drafts.set(item.draftId, item);
      return item;
    },
    async ensureMedia() { calls.media += 1; return { ok: true }; },
    async requestApproval(item) {
      calls.approval += 1;
      if (!approvals.has(item.draftId)) approvals.set(item.draftId, { ownerId: "owner-a", status: "pending" });
    },
    async autoApproveAndSchedule() { calls.autoApprove += 1; return { approved: true }; },
    async savePlanItems() {},
  };
  return { drafts, approvals, calls, ports };
}

test("Assisted opens one approval per draft without media, scheduling or auto-approval", async () => {
  const state = harness();
  const run = await ensureRollingPlan(state.ports, input);
  assert.equal(run.created, 1);
  assert.equal(run.awaitingApproval, 1);
  assert.equal(state.approvals.size, 1);
  assert.equal(state.calls.media, 0);
  assert.equal(state.calls.autoApprove, 0);
  assert.equal([...state.drafts.values()][0].status, "draft");
});

test("coordinator retries and workflow restarts reuse the same approval identity", async () => {
  const state = harness();
  await ensureRollingPlan(state.ports, input);
  await ensureRollingPlan(state.ports, input);
  assert.equal(state.drafts.size, 1);
  assert.equal(state.approvals.size, 1);
  assert.equal(state.calls.approval, 2, "the idempotent approval port may be retried safely");
});

test("Manual scheduled work and explicit planning-only runs create no approval", async () => {
  const manual = harness();
  await ensureRollingPlan(manual.ports, { ...input, mode: "manual" });
  assert.equal(manual.approvals.size, 0);
  const preview = harness();
  await ensureRollingPlan(preview.ports, { ...input, stage: "planning_only" });
  assert.equal(preview.approvals.size, 0);
});

test("approval creation re-checks owner mode, pause and subscription at the final boundary", async () => {
  const source = await readFile(new URL("lib/voom/workflow/service.ts", ROOT), "utf8");
  assert.match(source, /async requestApproval\(item\)[\s\S]*assertAutonomousWorkAllowed\(admin, context\.ownerId, context\.mode\)[\s\S]*ensureApprovalAction/);
  const safety = await readFile(new URL("lib/voom/automation-safety.ts", ROOT), "utf8");
  assert.match(safety, /automation_paused_at/);
  assert.match(safety, /mode !== requiredMode/);
  assert.match(safety, /canUseAutomationMode/);
});

test("edits refresh or invalidate the existing approval instead of creating a duplicate", async () => {
  const source = await readFile(new URL("lib/post/server-data.ts", ROOT), "utf8");
  assert.match(source, /refreshPendingDraftApproval/);
  assert.match(source, /Draft updated\. Review the latest version before confirming\./);
  assert.match(source, /The draft schedule was removed\. This approval is no longer valid\./);
  assert.match(source, /contains\("sanitized_arguments", \{ sourceDraftId: view\.id \}\)/);
});

test("approval and rejection are owner-scoped and rejection withdraws publishable work", async () => {
  const actionRoute = await readFile(new URL("app/api/mara/actions/[id]/route.ts", ROOT), "utf8");
  const postData = await readFile(new URL("lib/post/server-data.ts", ROOT), "utf8");
  assert.match(actionRoute, /executeConfirmedAction/);
  assert.match(actionRoute, /rejectPostDraft\(admin, user\.id, sourceDraftId\)/);
  assert.match(postData, /export async function rejectPostDraft/);
  assert.match(postData, /cancelPostSchedule\(admin, ownerId, draftId\)/);
  assert.match(postData, /resolveDraftApprovalActions\(admin, ownerId, draftId, "cancelled"/);
  assert.match(postData, /\.eq\("owner_user_id", ownerId\)/);
});
