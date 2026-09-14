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
  assert.match(route, /Delivered will appear only after a verified provider callback confirms it/);
  assert.doesNotMatch(route, /mark.*Delivered.*provider API success/i);

  // SMS is retired: no SMS provider call exists and SMS/multi rows are
  // refused (HTTP 410) rather than executed. Historical rows stay readable
  // everywhere else; only sending is blocked.
  assert.doesNotMatch(route, /sendSmsCampaign/);
  assert.doesNotMatch(route, /@\/lib\/sms/);
  assert.match(route, /campaign\.kind === "sms" \|\| campaign\.kind === "multi"/);
  assert.match(route, /\{ status: 410 \}/);
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

test("campaign editor exposes one-recipient email send UI with truthful states", async () => {
  const modal = await read("components/voom/modals/CampaignEditorModal.tsx");
  assert.match(modal, /Recipient email/);
  assert.match(modal, /One recipient for this MVP/);
  assert.match(modal, /Send approved/);
  assert.match(modal, /Accepted by provider/);
  assert.match(modal, /Delivered/);
  assert.match(modal, /Failed/);
  assert.match(modal, /delivery\?\.canSend/);
  assert.match(modal, /status === "approved"/);
  assert.doesNotMatch(modal, /bulk/i);
  // No SMS destination field in the email-only editor.
  assert.doesNotMatch(modal, /Recipient phone/);
  assert.doesNotMatch(modal, /E\.164/);
});

test("campaign PATCH accepts email kind for backward safety but the editor never sends kind on PATCH", async () => {
  const [itemRoute, modal] = await Promise.all([
    read("app/api/voom/campaigns/[id]/route.ts"),
    read("components/voom/modals/CampaignEditorModal.tsx"),
  ]);

  // PATCH schema tolerates kind=email (immutable on edit) so old email
  // clients don't 400; SMS is never creatable.
  assert.match(itemRoute, /kind: z\.literal\("email"\)\.optional\(\)/);
  assert.doesNotMatch(itemRoute, /kind: z\.enum\(\["email", "sms"\]\)/);
  // The editor keeps kind in the POST payload only; PATCH sends draft content.
  assert.match(modal, /const body = id \? payload\(\) : \{ kind: "email", \.\.\.payload\(\) \};/);
  // Historical SMS campaigns and automated containers are never editable.
  assert.match(itemRoute, /existing\.kind === "sms"/);
  assert.match(itemRoute, /existing\.kind === "multi" \|\| existing\.is_automated/);
});

test("campaign editor labels the real email destination and the retired SMS channel has no validation path", async () => {
  const [modal, deliveryRoute] = await Promise.all([
    read("components/voom/modals/CampaignEditorModal.tsx"),
    read("app/api/voom/campaigns/[id]/delivery/route.ts"),
  ]);

  // Explicit real destination field: Email -> recipient email.
  assert.match(modal, /Recipient email/);
  assert.doesNotMatch(modal, /Recipient phone/);
  // Audience stays descriptive only and is not treated as the destination.
  assert.match(modal, /label="Audience"/);

  // Email validation message remains; no phone validation exists anywhere.
  assert.match(deliveryRoute, /Enter a valid recipient email address\./);
  assert.doesNotMatch(deliveryRoute, /Enter a valid (?:E\.164 )?phone number/);
});

test("automation paths still never send campaigns externally", async () => {
  const [workflow, automation, tools] = await Promise.all([
    read("lib/voom/workflow/service.ts"),
    read("lib/voom/weekly-automation.ts"),
    read("lib/mara/tools.ts"),
  ]);
  assert.doesNotMatch(workflow, /sendApprovedCampaign|claim_campaign_send|record_campaign_send_provider_result|createResendClient|createClickSendClient/);
  assert.doesNotMatch(automation, /claim_campaign_send|record_campaign_send_provider_result|resend|twilio|clicksend/i);
  assert.match(tools, /sendingAvailable: false/);
});
