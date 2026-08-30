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
  assert.match(route, /sendSmsCampaign\(campaign, recipient\)/);
  assert.match(route, /Delivered will appear only after a verified provider callback confirms it/);
  assert.doesNotMatch(route, /mark.*Delivered.*provider API success/i);
});

test("Resend webhook route verifies signatures before delivery updates and no unverified SMS webhook exists", async () => {
  const [helper, resend] = await Promise.all([
    read("lib/voom/campaign-delivery.ts"),
    read("app/api/webhooks/resend/route.ts"),
  ]);

  assert.match(helper, /new Webhook\(secret\)\.verify/);
  assert.match(helper, /rpc\("record_campaign_delivery_event"/);
  assert.match(resend, /svix-id/);
  assert.match(resend, /verifyResendWebhook/);
  assert.match(resend, /recordDeliveryFromWebhook/);

  // The Twilio webhook route was removed with the ClickSend provider swap, and
  // no ClickSend delivery webhook may be faked without a safe verified path.
  await assert.rejects(read("app/api/webhooks/twilio/status/route.ts"));
  assert.doesNotMatch(helper, /verifyTwilioSignature|createHmac\("sha1"|timingSafeEqual|x-twilio-signature/);
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

test("campaign PATCH accepts kind for backward safety but the editor never sends it on PATCH", async () => {
  const [itemRoute, modal] = await Promise.all([
    read("app/api/voom/campaigns/[id]/route.ts"),
    read("components/voom/modals/CampaignEditorModal.tsx"),
  ]);

  // PATCH schema may tolerate kind (immutable on edit) so old clients don't 400.
  assert.match(itemRoute, /kind: z\.enum\(\["email", "sms"\]\)\.optional\(\)/);
  // The editor keeps kind in the POST payload only; PATCH sends draft content,
  // so editing an existing campaign no longer rejects on the strict schema.
  assert.match(modal, /const body = id \? payload\(\) : \{ kind, \.\.\.payload\(\) \};/);
});

test("campaign editor labels the real destination fields and SMS validation uses international format", async () => {
  const [modal, deliveryRoute] = await Promise.all([
    read("components/voom/modals/CampaignEditorModal.tsx"),
    read("app/api/voom/campaigns/[id]/delivery/route.ts"),
  ]);

  // Explicit real destination fields: Email -> recipient email, SMS -> recipient phone number.
  assert.match(modal, /Recipient email/);
  assert.match(modal, /Recipient phone number/);
  // Audience stays descriptive only and is not treated as the destination.
  assert.match(modal, /label="Audience"/);
  assert.doesNotMatch(modal, /Recipient phone\b(?! number)/);

  // Validation messages per requirement.
  assert.match(deliveryRoute, /Enter a valid recipient email address\./);
  assert.match(deliveryRoute, /Enter a valid phone number in international format\./);
  assert.doesNotMatch(deliveryRoute, /Enter a valid E\.164 phone number like \+971501234567\./);
});

test("automation paths still never send campaigns externally", async () => {
  const [workflow, automation, tools] = await Promise.all([
    read("lib/mara/plan-workflow.ts"),
    read("lib/voom/weekly-automation.ts"),
    read("lib/mara/tools.ts"),
  ]);
  assert.doesNotMatch(workflow, /sendApprovedCampaign|claim_campaign_send|record_campaign_send_provider_result|createResendClient|createClickSendClient/);
  assert.doesNotMatch(automation, /claim_campaign_send|record_campaign_send_provider_result|resend|twilio|clicksend/i);
  assert.match(tools, /sendingAvailable: false/);
});
