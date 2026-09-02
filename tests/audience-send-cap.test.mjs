import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

// Build n labeled "destinations"; only the count matters to the planner.
const items = (n) => Array.from({ length: n }, (_, i) => `dst-${i}`);

test("at exactly the cap (100 eligible), every destination is planned — all 100 send", async () => {
  const { planAudienceSend } = await import("../lib/voom/audience-send-plan.ts");
  const plan = planAudienceSend(items(100), 100);
  assert.equal(plan.ok, true);
  assert.equal(plan.batch.length, 100);
  assert.equal(plan.overLimit, 0);
  assert.equal(plan.batch[99], "dst-99");
});

test("under the cap, every eligible destination is planned", async () => {
  const { planAudienceSend } = await import("../lib/voom/audience-send-plan.ts");
  for (const n of [1, 50, 99]) {
    const plan = planAudienceSend(items(n), 100);
    assert.equal(plan.ok, true, `n=${n} must be allowed`);
    assert.equal(plan.batch.length, n, `n=${n} must be fully planned`);
  }
});

test("one over the cap (101 eligible) REFUSES the entire send — zero recipients", async () => {
  const { planAudienceSend } = await import("../lib/voom/audience-send-plan.ts");
  const plan = planAudienceSend(items(101), 100);
  assert.equal(plan.ok, false);
  assert.deepEqual(
    { reason: plan.reason, total: plan.total, cap: plan.cap, overLimit: plan.overLimit },
    { reason: "over_cap", total: 101, cap: 100, overLimit: 1 },
  );
  // A refused plan must not expose any batch — there is nothing to send.
  assert.ok(!("batch" in plan), "a refused plan must carry no batch, so zero recipients can be contacted");
});

test("well over the cap (250 eligible) refuses the entire send — zero sends", async () => {
  const { planAudienceSend } = await import("../lib/voom/audience-send-plan.ts");
  const plan = planAudienceSend(items(250), 100);
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "over_cap");
  assert.equal(plan.total, 250);
  assert.equal(plan.overLimit, 150);
  assert.ok(!("batch" in plan));
});

test("the planner never slices: the batch is always complete or absent", async () => {
  const { planAudienceSend } = await import("../lib/voom/audience-send-plan.ts");
  for (const n of [0, 1, 73, 100]) {
    const plan = planAudienceSend(items(n), 100);
    assert.equal(plan.ok, true, `n=${n} must be allowed`);
    assert.deepEqual(plan.batch, items(n), `n=${n} batch must contain every destination, unsliced`);
  }
  for (const n of [101, 200, 1000]) {
    const plan = planAudienceSend(items(n), 100);
    assert.equal(plan.ok, false, `n=${n} must be refused`);
    assert.ok(!("batch" in plan), `n=${n} must expose no batch`);
    assert.equal(plan.total, n);
  }
});

test("the send route gates on the refusal plan before touching recipients or providers", async () => {
  const route = await read("app/api/voom/campaigns/[id]/delivery/route.ts");
  const audienceFn = route.slice(route.indexOf("async function sendToLinkedAudience"));
  const guard = audienceFn.indexOf("if (!plan.ok)");
  assert.ok(guard > -1);
  // The refusal branch returns a 422 over-cap error with zero sends...
  const refusalBranch = audienceFn.slice(guard, audienceFn.indexOf("const batch = plan.batch"));
  assert.match(refusalBranch, /return Response\.json/);
  assert.match(refusalBranch, /\{ status: 422 \}/);
  assert.match(refusalBranch, /attempted: 0/);
  assert.match(refusalBranch, /accepted: 0/);
  assert.match(refusalBranch, /failed: 0/);
  assert.match(refusalBranch, /skipped: plan\.total/);
  // ...and makes no recipient write, claim, or provider call at all.
  assert.doesNotMatch(refusalBranch, /createAdminClient|add_campaign_recipient|claim_campaign_send|record_campaign_send_provider_result|sendEmailCampaign|sendSmsCampaign/);
});

test("the server delivery view disables sending for over-cap audiences", async () => {
  const helper = await read("lib/voom/campaign-delivery.ts");
  assert.match(helper, /audience\.eligibleCount > 0 && audience\.overLimitCount === 0/);
  assert.match(helper, /an over-limit send is refused entirely/);
});
