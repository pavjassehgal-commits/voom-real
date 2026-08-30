import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("manual send route is approval-gated, provider-backed, and double-send safe", async () => {
  const route = await read("app/api/voom/campaigns/[id]/delivery/route.ts");
  assert.match(route, /export async function POST/);
  assert.match(route, /campaign\.status !== "approved"/);
  assert.match(route, /createAdminClient\(/);
  assert.match(route, /rpc\("add_campaign_recipient"/);
  assert.match(route, /rpc\("claim_campaign_send"/);
  assert.match(route, /rpc\("record_campaign_send_provider_result"/);
  assert.match(route, /createCampaignSendAttemptKey/);
  assert.match(route, /claimed\.idempotency_key !== attemptKey/);
  assert.match(route, /sendEmailCampaign\(campaign, recipient\)/);
  assert.match(route, /sendSmsCampaign\(campaign, recipient, request\.url\)/);
  assert.match(route, /Delivered will appear only after a verified provider callback confirms it/);
  assert.doesNotMatch(route, /mark.*Delivered.*provider API success/i);
});

test("Resend and Twilio webhook routes verify signatures before delivery updates", async () => {
  const [helper, resend, twilio] = await Promise.all([
    read("lib/voom/campaign-delivery.ts"),
    read("app/api/webhooks/resend/route.ts"),
    read("app/api/webhooks/twilio/status/route.ts"),
  ]);

  assert.match(helper, /new Webhook\(secret\)\.verify/);
  assert.match(helper, /createHmac\("sha1"/);
  assert.match(helper, /timingSafeEqual/);
  assert.match(helper, /rpc\("record_campaign_delivery_event"/);
  assert.match(resend, /svix-id/);
  assert.match(resend, /verifyResendWebhook/);
  assert.match(resend, /recordDeliveryFromWebhook/);
  assert.match(twilio, /x-twilio-signature/);
  assert.match(twilio, /verifyTwilioSignature/);
  assert.match(twilio, /recordDeliveryFromWebhook/);
});

test("campaign editor exposes one-recipient send UI with truthful states", async () => {
  const modal = await read("components/voom/modals/CampaignEditorModal.tsx");
  assert.match(modal, /Recipient email/);
  assert.match(modal, /Recipient phone/);
  assert.match(modal, /One recipient for this MVP/);
  assert.match(modal, /Send approved/);
  assert.match(modal, /Accepted by provider/);
  assert.match(modal, /Delivered/);
  assert.match(modal, /Failed/);
  assert.match(modal, /delivery\?\.canSend/);
  assert.match(modal, /status === "approved"/);
  assert.doesNotMatch(modal, /bulk/i);
});

test("automation paths still never send campaigns externally", async () => {
  const [workflow, automation, tools] = await Promise.all([
    read("lib/mara/plan-workflow.ts"),
    read("lib/voom/weekly-automation.ts"),
    read("lib/mara/tools.ts"),
  ]);
  assert.doesNotMatch(workflow, /sendApprovedCampaign|claim_campaign_send|record_campaign_send_provider_result|createResendClient|createTwilioClient/);
  assert.doesNotMatch(automation, /claim_campaign_send|record_campaign_send_provider_result|resend|twilio/i);
  assert.match(tools, /sendingAvailable: false/);
});
