/**
 * Durable video timeout reconciliation and approval-state repair.
 *
 * THE PRODUCTION FAULTS THIS COVERS
 *
 *   1. A Seedance job whose video actually finished at minute 29:50 was failed
 *      as `provider_timeout` at minute 30 WITHOUT ever asking the provider for
 *      its final status. The account had already paid for that video and Voom
 *      threw it away.
 *   2. A job that completed AFTER an earlier timeout stayed failed forever,
 *      because nothing ever looked at a terminal row again.
 *   3. Queue rows were written `not_approved` when the draft read merely
 *      failed or raced. That code is terminal, so genuinely approved items
 *      could never publish again — a silently dead schedule.
 *   4. A failed publish on an item with NO stored visual reported "publishing
 *      failed" and offered "Post now", which cannot work without media.
 *
 * Real modules under test. NO OpenRouter call, NO paid generation, NO
 * publishing, NO cron invocation, NO media generated:
 *   lib/mara/video-job.ts         — the pure reconcile/timeout decision
 *   lib/instagram/publishing.ts   — failure vocabulary + the repair predicate
 *   lib/instagram/publish-flow.ts — the real publish sequence, faked ports
 *   lib/voom/workflow/state.ts    — failure-stage precedence
 *   lib/voom/workflow/next-actions.ts — the one next-action engine
 *   lib/voom/automation.ts        — mode-change semantics
 */
import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import test from "node:test";

const videoJob = await import("../lib/mara/video-job.ts");
const publishing = await import("../lib/instagram/publishing.ts");
const publishFlow = await import("../lib/instagram/publish-flow.ts");
const state = await import("../lib/voom/workflow/state.ts");
const nextActions = await import("../lib/voom/workflow/next-actions.ts");
const automation = await import("../lib/voom/automation.ts");

const NOW = Date.parse("2026-09-13T12:00:00.000Z");
const minutesAgo = (minutes) => NOW - minutes * 60_000;
const HANDLE = "j4McHGlLAPqr6PSmyqf8";

// ===========================================================================
// 1. One final reconciliation before the 30-minute timeout
// ===========================================================================

test("1a. an active job past its hard timeout is reconciled once before being written off", () => {
  const decision = videoJob.reconcileDecision({
    status: "generating",
    providerJobId: HANDLE,
    clock: { nowMs: NOW, createdAtMs: minutesAgo(31) },
  });
  assert.equal(decision, "reconcile", "the provider is asked once more before the job is abandoned");
});

test("1b. a job still inside its lifetime is left alone entirely", () => {
  assert.equal(videoJob.reconcileDecision({
    status: "generating",
    providerJobId: HANDLE,
    clock: { nowMs: NOW, createdAtMs: minutesAgo(5) },
  }), "none", "a healthy in-flight job is neither reconciled nor timed out");
});

test("1c. without a usable provider handle the timeout is a pure database truth", () => {
  for (const handle of [null, undefined, ""]) {
    assert.equal(videoJob.reconcileDecision({
      status: "generating",
      providerJobId: handle,
      clock: { nowMs: NOW, createdAtMs: minutesAgo(31) },
    }), "timeout", "there is nothing safe to poll, so no provider call is made");
  }
});

test("1d. the hard timeout number itself is unchanged at 30 minutes", () => {
  assert.equal(videoJob.VIDEO_JOB_TIMEOUT_MINUTES, 30);
  assert.equal(state.MEDIA_GENERATION_HARD_TIMEOUT_MINUTES, 30, "one shared number, never a second one");
  // Just inside the limit is not yet reconcilable; just past it is.
  assert.equal(videoJob.reconcileDecision({
    status: "generating", providerJobId: HANDLE,
    clock: { nowMs: NOW, createdAtMs: minutesAgo(29) },
  }), "none");
  assert.equal(videoJob.reconcileDecision({
    status: "generating", providerJobId: HANDLE,
    clock: { nowMs: NOW, createdAtMs: minutesAgo(31) },
  }), "reconcile");
});

// ===========================================================================
// 2. Recovering a completed, previously timed-out job
// ===========================================================================

test("2a. a job already stopped as provider_timeout stays recoverable inside its window", () => {
  assert.equal(videoJob.reconcileDecision({
    status: "failed",
    errorCode: "provider_timeout",
    providerJobId: HANDLE,
    clock: { nowMs: NOW, createdAtMs: minutesAgo(90) },
  }), "reconcile", "a video the provider finished late is worth collecting — it is already paid for");
});

test("2b. a genuine provider failure is terminal forever and never re-polled", () => {
  for (const code of ["rejected", "invalid_output", "insufficient_credits", "unsupported_input"]) {
    assert.equal(videoJob.reconcileDecision({
      status: "failed",
      errorCode: code,
      providerJobId: HANDLE,
      clock: { nowMs: NOW, createdAtMs: minutesAgo(90) },
    }), "none", `${code} is a real answer, not an unknown — it is never retried`);
  }
});

test("2c. a cold handle past the recovery window is abandoned rather than polled forever", () => {
  assert.equal(videoJob.reconcileDecision({
    status: "failed",
    errorCode: "provider_timeout",
    providerJobId: HANDLE,
    clock: { nowMs: NOW, createdAtMs: minutesAgo(videoJob.VIDEO_JOB_RECOVERY_WINDOW_MINUTES + 60) },
  }), "none");
  // A completed or cancelled row is never reconciled either.
  for (const status of ["completed", "cancelled"]) {
    assert.equal(videoJob.reconcileDecision({
      status, providerJobId: HANDLE, clock: { nowMs: NOW, createdAtMs: minutesAgo(31) },
    }), "none");
  }
});

test("2d. a recovered timeout keeps the SAME provider job id — reconciliation never re-submits", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile("lib/mara/video-poller.ts", "utf8"));
  // The worker's only provider verb is polling. createVideoJob is unreachable.
  assert.doesNotMatch(source, /createVideoJob/, "the durable worker can never submit a job");
  assert.match(source, /reconcileDecision/);
  const generation = await import("node:fs/promises").then((fs) => fs.readFile("lib/mara/video-generation.ts", "utf8"));
  const advanceBody = generation.slice(generation.indexOf("export async function advanceVideoGeneration"));
  assert.doesNotMatch(advanceBody, /ports\.createVideoJob/, "advancing a job never creates a second one");
});

// ===========================================================================
// 3. A real provider failure outranks a generic timeout
// ===========================================================================

test("3a. the failure vocabulary keeps timeout and real provider faults distinct", () => {
  assert.equal(videoJob.VIDEO_JOB_TIMEOUT_ERROR_CODE, "provider_timeout");
  // Each real code keeps its own truthful, non-leaking user message.
  const timeout = videoJob.videoJobSafeError("provider_timeout");
  const rejected = videoJob.videoJobSafeError("rejected");
  const credits = videoJob.videoJobSafeError("insufficient_credits");
  assert.notEqual(timeout, rejected);
  assert.notEqual(rejected, credits);
  for (const message of [timeout, rejected, credits]) {
    assert.match(message, /previous asset is unchanged|nothing was charged/i);
  }
});

// ===========================================================================
// 4. Repairing a stuck not_approved queue state
// ===========================================================================

test("4a. an approved draft stuck as not_approved is repaired", () => {
  assert.equal(publishing.shouldRepairNotApproved({
    status: "failed",
    failureCode: "not_approved",
    instagramMediaId: null,
    draftStatus: "approved",
  }), true, "the item was approved all along — its dead schedule is restored");
});

test("4b. an item the user genuinely did not approve is NEVER resurrected", () => {
  for (const draftStatus of ["draft", "rejected", ""]) {
    assert.equal(publishing.shouldRepairNotApproved({
      status: "failed",
      failureCode: "not_approved",
      instagramMediaId: null,
      draftStatus,
    }), false, `a ${draftStatus || "missing"} draft stays terminal`);
  }
});

test("4c. the repair never touches published items or unrelated failures", () => {
  assert.equal(publishing.shouldRepairNotApproved({
    status: "failed", failureCode: "not_approved", instagramMediaId: "17999", draftStatus: "approved",
  }), false, "a published item is never re-queued — that would risk a second post");
  assert.equal(publishing.shouldRepairNotApproved({
    status: "failed", failureCode: "container_error", instagramMediaId: null, draftStatus: "approved",
  }), false, "an unrelated failure is not swept up by the repair");
  assert.equal(publishing.shouldRepairNotApproved({
    status: "published", failureCode: "not_approved", instagramMediaId: null, draftStatus: "approved",
  }), false);
});

test("4d. an unreadable draft is retried, not branded not_approved", async () => {
  const ports = makeFlowPorts({ loadDraft: async () => { throw new Error("transient database blip"); } });
  const result = await publishFlow.runPublishFlow(flowItem(), ports);
  assert.equal(result.outcome, "retrying", "a blip must not permanently kill an approved schedule");
  assert.equal(result.code, "draft_unavailable");
  assert.notEqual(result.code, "not_approved");
  assert.equal(ports.calls.containers.length, 0, "nothing is published while approval is unconfirmed");

  // A missing row is the same uncertainty, handled the same way.
  const missing = makeFlowPorts({ loadDraft: async () => null });
  const missingResult = await publishFlow.runPublishFlow(flowItem(), missing);
  assert.equal(missingResult.code, "draft_unavailable");
  assert.equal(missing.calls.containers.length, 0);
});

test("4e. a genuinely rejected draft is still terminal and still never publishes", async () => {
  const ports = makeFlowPorts({ loadDraft: async () => ({ status: "rejected", content: "x" }) });
  const result = await publishFlow.runPublishFlow(flowItem(), ports);
  assert.equal(result.outcome, "failed");
  assert.equal(result.code, "not_approved");
  assert.equal(ports.calls.containers.length, 0);
});

// ===========================================================================
// 5. Media failure outranks the secondary publish failure
// ===========================================================================

test("5a. a missing visual is named as the cause, not the publish attempt it broke", () => {
  const facts = {
    draftStatus: "approved",
    hasMedia: false,
    mediaStatus: "failed",
    publishStatus: "failed",
    awaitingApproval: false,
  };
  assert.equal(state.failureStage(facts), "media", "the publish failure is the symptom; the missing visual is the cause");
});

test("5b. a publish failure with media stored is still reported as publishing", () => {
  assert.equal(state.failureStage({
    draftStatus: "approved",
    hasMedia: true,
    mediaStatus: "completed",
    publishStatus: "failed",
    awaitingApproval: false,
  }), "publishing");
  // A permission problem is a publishing problem too.
  assert.equal(state.failureStage({
    draftStatus: "approved",
    hasMedia: true,
    mediaStatus: "completed",
    publishStatus: "permission_required",
    awaitingApproval: false,
  }), "publishing");
});

test("5c. a failed media stage sends the user to the action that actually fixes it", () => {
  const resolved = nextActions.planItemActions({
    contentType: "reel", stage: "failed", failedStage: "media", mode: "assisted",
    publishAt: "2026-09-13T15:15:00.000Z", hasMedia: false,
  });
  const ids = resolved.actions.map((action) => action.id);
  assert.ok(ids.includes("retry_media"), "retrying the generation is offered");
  assert.ok(!ids.includes("post_now"), "posting cannot fix a missing visual");
});

// ===========================================================================
// 6. No "Post now" without stored media
// ===========================================================================

test("6a. a missed item with no stored visual cannot be posted now", () => {
  const resolved = nextActions.planItemActions({
    contentType: "post", stage: "missed", failedStage: null, mode: "autopilot",
    publishAt: "2026-09-13T05:00:00.000Z", hasMedia: false,
  });
  const postNow = resolved.actions.find((action) => action.id === "post_now");
  assert.ok(postNow, "the primary action stays visible so the card is not empty");
  assert.equal(postNow.disabled, true);
  assert.match(String(postNow.disabledReason), /no stored visual/i);
});

test("6b. the same card with stored media offers a live Post now", () => {
  const resolved = nextActions.planItemActions({
    contentType: "post", stage: "missed", failedStage: null, mode: "autopilot",
    publishAt: "2026-09-13T05:00:00.000Z", hasMedia: true,
  });
  const postNow = resolved.actions.find((action) => action.id === "post_now");
  assert.notEqual(postNow.disabled, true);
  assert.match(String(postNow.hint), /never a second copy/i);
});

test("6c. a publishing failure with no media leads with recovery, not with Post now", () => {
  const resolved = nextActions.planItemActions({
    contentType: "post", stage: "failed", failedStage: "publishing", mode: "assisted",
    publishAt: "2026-09-13T05:00:00.000Z", hasMedia: false,
  });
  const ids = resolved.actions.map((action) => action.id);
  assert.ok(!ids.includes("post_now"), "posting would just fail again on the same missing media");
  assert.ok(ids.includes("retry_media") && ids.includes("upload_asset"));
});

test("6d. the server action refuses Post now without a stored visual", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile("lib/voom/workflow/actions-server.ts", "utf8"));
  const body = source.slice(source.indexOf("export async function postPlanItemNow"));
  // The server is the real guard; the disabled button is only the UI hint.
  assert.match(body.slice(0, body.indexOf("enqueuePublishItem")), /visualReady/);
});

// ===========================================================================
// 7. Autopilot -> Manual affects FUTURE automation only
// ===========================================================================

test("7a. switching off Autopilot stops future runs without touching existing work", () => {
  const effect = automation.automationModeChangeEffect("autopilot", "manual");
  assert.equal(effect.futureAutomationEnabled, false, "no further scheduled runs for this account");
  assert.equal(effect.futureAutoApproval, false);
  assert.equal(effect.cancelsExistingSchedules, false, "approved schedules the user accepted still publish");
  assert.equal(effect.revokesExistingApprovals, false);
  assert.equal(effect.deletesExistingMedia, false, "media already paid for is kept");
  assert.match(effect.message, /already approved/i);
});

test("7b. Autopilot -> Assisted keeps automation running but stops self-approval", () => {
  const effect = automation.automationModeChangeEffect("autopilot", "assisted");
  assert.equal(effect.futureAutomationEnabled, true);
  assert.equal(effect.futureAutoApproval, false);
  assert.equal(effect.cancelsExistingSchedules, false);
  assert.match(effect.message, /no longer approve or schedule/i);
});

test("7c. only Assisted and Autopilot are picked up by the scheduled runner", () => {
  assert.equal(automation.automationRunsAutomatically("manual"), false);
  assert.equal(automation.automationRunsAutomatically("assisted"), true);
  assert.equal(automation.automationRunsAutomatically("autopilot"), true);
  // Turning automation back on never retroactively invents past work either.
  const resumed = automation.automationModeChangeEffect("manual", "autopilot");
  assert.equal(resumed.futureAutomationEnabled, true);
  assert.equal(resumed.cancelsExistingSchedules, false);
  assert.match(resumed.message, /future runs/i);
});

test("7d. no mode change ever reports destroying existing work", () => {
  for (const from of automation.AUTOMATION_MODES) {
    for (const to of automation.AUTOMATION_MODES) {
      const effect = automation.automationModeChangeEffect(from, to);
      assert.equal(effect.cancelsExistingSchedules, false, `${from} -> ${to} must not cancel schedules`);
      assert.equal(effect.revokesExistingApprovals, false, `${from} -> ${to} must not revoke approvals`);
      assert.equal(effect.deletesExistingMedia, false, `${from} -> ${to} must not delete media`);
      assert.ok(effect.message.length > 0);
    }
  }
});

// ---------------------------------------------------------------------------
// Fake publish ports — no Meta call, no network, nothing published.
// ---------------------------------------------------------------------------

function flowItem() {
  return {
    id: "queue-1",
    ownerUserId: "owner-1",
    draftId: "draft-1",
    mediaKind: "image",
    caption: "A safe test caption.",
    attempts: 0,
    containerId: null,
    instagramMediaId: null,
  };
}

function makeFlowPorts(overrides = {}) {
  const calls = { failed: [], containers: [], published: [] };
  const ports = {
    calls,
    async loadDraft() { return { status: "approved", content: "A safe test caption." }; },
    async loadConnection() {
      return { status: "connected", scopes: ["instagram_business_content_publish"], tokenExpiresAt: null };
    },
    async loadCredentials() { return { igUserId: "ig-1", accessToken: "token-1" }; },
    async loadAsset() { return { storagePath: "owner-1/post-assets/a.jpg", mimeType: "image/jpeg", status: "uploaded" }; },
    async signMediaUrl() { return "https://signed.invalid/a.jpg"; },
    async createContainer(input) { calls.containers.push(input); return "container-1"; },
    async containerStatus() { return "FINISHED"; },
    async publishContainer() { return "17999"; },
    async findPublishedMediaId() { return null; },
    async persistContainerId() {},
    async markPublished(item, mediaId) { calls.published.push(mediaId); },
    async markFailed(item, input) { calls.failed.push(input); },
    async sleep() {},
    now: () => NOW,
    ...overrides,
  };
  return ports;
}
