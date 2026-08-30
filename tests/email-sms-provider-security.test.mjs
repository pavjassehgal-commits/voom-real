import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("Email and SMS provider secrets remain server-only", async () => {
  const env = await read(".env.example");
  for (const name of [
    "EMAIL_PROVIDER_API_KEY",
    "EMAIL_FROM_ADDRESS",
    "EMAIL_FROM_NAME",
    "EMAIL_WEBHOOK_SECRET",
    "CLICKSEND_USERNAME",
    "CLICKSEND_API_KEY",
  ]) {
    assert.match(env, new RegExp(`^${name}=$`, "m"));
    assert.doesNotMatch(env, new RegExp(`NEXT_PUBLIC_${name}`));
  }

  const [emailConfig, emailClient, emailIndex, smsConfig, smsClient, smsIndex, campaigns] = await Promise.all([
    read("lib/email/config.ts"),
    read("lib/email/client.ts"),
    read("lib/email/index.ts"),
    read("lib/sms/config.ts"),
    read("lib/sms/client.ts"),
    read("lib/sms/index.ts"),
    read("app/app/(shell)/campaigns/page.tsx"),
  ]);

  for (const source of [emailConfig, emailClient, emailIndex, smsConfig, smsClient, smsIndex]) {
    assert.match(source, /import "server-only"/);
  }

  assert.doesNotMatch(campaigns, /EMAIL_PROVIDER_API_KEY|EMAIL_FROM_ADDRESS|EMAIL_FROM_NAME|EMAIL_WEBHOOK_SECRET|CLICKSEND_USERNAME|CLICKSEND_API_KEY/);
});

test("Resend configuration validates required server env and exposes truthful availability", async () => {
  const { EmailProviderConfigurationError, getResendAvailability, readResendConfig, requireResendConfig } = await import("../lib/email/core.ts");

  const partial = getResendAvailability({
    EMAIL_PROVIDER_API_KEY: "  resend_test_key  ",
    EMAIL_FROM_ADDRESS: "founder@example.com",
  });
  assert.equal(partial.provider, "resend");
  assert.equal(partial.sendConfigured, false);
  assert.equal(partial.webhookConfigured, false);
  assert.equal(partial.configured, false);
  assert.deepEqual(partial.missingEnv, ["EMAIL_FROM_NAME", "EMAIL_WEBHOOK_SECRET"]);
  assert.equal(readResendConfig({
    EMAIL_PROVIDER_API_KEY: "resend_test_key",
    EMAIL_FROM_ADDRESS: "founder@example.com",
    EMAIL_FROM_NAME: "Voom",
  }), null);

  const fullEnv = {
    EMAIL_PROVIDER_API_KEY: "resend_test_key",
    EMAIL_FROM_ADDRESS: "founder@example.com",
    EMAIL_FROM_NAME: "Voom",
    EMAIL_WEBHOOK_SECRET: "whsec_test",
  };
  const availability = getResendAvailability(fullEnv);
  assert.equal(availability.sendConfigured, true);
  assert.equal(availability.webhookConfigured, true);
  assert.equal(availability.configured, true);
  assert.deepEqual(availability.missingEnv, []);

  assert.deepEqual(readResendConfig(fullEnv), {
    provider: "resend",
    apiKey: "resend_test_key",
    fromAddress: "founder@example.com",
    fromName: "Voom",
    webhookSecret: "whsec_test",
    apiBaseUrl: "https://api.resend.com",
  });

  assert.throws(() => requireResendConfig({}), (error) => {
    assert.ok(error instanceof EmailProviderConfigurationError);
    assert.equal(error.message, "email_provider_not_configured");
    assert.equal(error.availability.configured, false);
    assert.match(error.availability.missingEnv.join(","), /EMAIL_PROVIDER_API_KEY/);
    return true;
  });
});

test("Resend client uses injected fetch with server auth headers", async () => {
  const { createResendApiClient } = await import("../lib/email/core.ts");

  let call = null;
  const client = createResendApiClient({
    provider: "resend",
    apiKey: "resend_test_key",
    fromAddress: "founder@example.com",
    fromName: "Voom",
    webhookSecret: "whsec_test",
    apiBaseUrl: "https://api.resend.com",
  }, {
    timeoutMs: 3210,
    fetch: async (input, init) => {
      call = { url: String(input), init };
      return new Response(JSON.stringify({ id: "email_123" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const response = await client.post("emails", { subject: "Preview", text: "Hello" });
  assert.equal(response.status, 202);
  assert.equal(call?.url, "https://api.resend.com/emails");
  assert.equal(call?.init?.method, "POST");
  assert.equal(call?.init?.body, JSON.stringify({ subject: "Preview", text: "Hello" }));
  assert.equal(call?.init?.cache, "no-store");
  assert.ok(call?.init?.signal instanceof AbortSignal);

  const headers = new Headers(call?.init?.headers);
  assert.equal(headers.get("Authorization"), "Bearer resend_test_key");
  assert.equal(headers.get("Content-Type"), "application/json");
  assert.equal(headers.get("Accept"), "application/json");
});

test("ClickSend configuration validates required server env and exposes truthful availability", async () => {
  const { SmsProviderConfigurationError, getClickSendAvailability, readClickSendConfig, requireClickSendConfig } = await import("../lib/sms/core.ts");

  const partial = getClickSendAvailability({
    CLICKSEND_USERNAME: "voom_founder",
  });
  assert.equal(partial.provider, "clicksend");
  assert.equal(partial.configured, false);
  assert.deepEqual(partial.missingEnv, ["CLICKSEND_API_KEY"]);
  assert.equal(readClickSendConfig({
    CLICKSEND_USERNAME: "",
    CLICKSEND_API_KEY: "clicksend_key",
  }), null);

  const fullEnv = {
    CLICKSEND_USERNAME: "  voom_founder  ",
    CLICKSEND_API_KEY: "clicksend_key",
  };
  const availability = getClickSendAvailability(fullEnv);
  assert.equal(availability.configured, true);
  assert.deepEqual(availability.missingEnv, []);

  assert.deepEqual(readClickSendConfig(fullEnv), {
    provider: "clicksend",
    username: "voom_founder",
    apiKey: "clicksend_key",
    apiBaseUrl: "https://rest.clicksend.com",
  });

  assert.throws(() => requireClickSendConfig({}), (error) => {
    assert.ok(error instanceof SmsProviderConfigurationError);
    assert.equal(error.message, "sms_provider_not_configured");
    assert.equal(error.availability.configured, false);
    assert.match(error.availability.missingEnv.join(","), /CLICKSEND_USERNAME/);
    return true;
  });
});

test("ClickSend client posts to v3 sms/send with basic auth and a JSON body", async () => {
  const { createClickSendApiClient } = await import("../lib/sms/core.ts");

  let call = null;
  const client = createClickSendApiClient({
    provider: "clicksend",
    username: "voom_founder",
    apiKey: "clicksend_key",
    apiBaseUrl: "https://rest.clicksend.com",
  }, {
    timeoutMs: 4321,
    fetch: async (input, init) => {
      call = { url: String(input), init };
      return new Response(JSON.stringify({
        http_code: 200,
        response_code: "SUCCESS",
        response_msg: "Message has been successfully sent.",
        data: { messages: [{ message_id: "D6D16B28-46AC-484A-AB0A-A08CD08EF75C" }] },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const response = await client.postJson("/v3/sms/send", {
    messages: [{ to: "+15551234567", body: "Hello from Voom" }],
  });
  assert.equal(response.status, 200);
  assert.equal(call?.url, "https://rest.clicksend.com/v3/sms/send");
  assert.equal(call?.init?.method, "POST");
  assert.equal(call?.init?.cache, "no-store");
  assert.ok(call?.init?.signal instanceof AbortSignal);

  const headers = new Headers(call?.init?.headers);
  // ClickSend v3 uses HTTP Basic auth with the username and the API key.
  assert.equal(headers.get("Authorization"), `Basic ${Buffer.from("voom_founder:clicksend_key", "utf8").toString("base64")}`);
  assert.equal(headers.get("Content-Type"), "application/json");
  assert.equal(headers.get("Accept"), "application/json");

  const payload = JSON.parse(String(call?.init?.body));
  assert.ok(Array.isArray(payload.messages));
  assert.equal(payload.messages.length, 1);
  assert.deepEqual(payload.messages[0], { to: "+15551234567", body: "Hello from Voom" });
});

test("SMS send is explicit-send only, invents no sender, and never fakes Delivered", async () => {
  const [helper, route] = await Promise.all([
    read("lib/voom/campaign-delivery.ts"),
    read("app/api/voom/campaigns/[id]/delivery/route.ts"),
  ]);

  // The runtime SMS provider is ClickSend, posted to the documented v3 endpoint.
  assert.match(helper, /provider: "clicksend"/);
  assert.match(helper, /label: "ClickSend"/);
  assert.match(helper, /clickSendSmsSendPath\(\)/);

  // sendSmsCampaign is the only SMS path: slice exactly that function (comments
  // stripped) so the email `from` header and unrelated `db.from()` calls can't
  // mask an invented SMS sender.
  const start = helper.indexOf("export async function sendSmsCampaign");
  const end = helper.indexOf("export function verifyResendWebhook", start);
  const smsFn = helper
    .slice(start, end > start ? end : undefined)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.match(smsFn, /messages:\s*\[\s*\{\s*to:\s*recipient\.contact,\s*body:\s*campaign\.content,?\s*\},?\s*\],?/);
  assert.doesNotMatch(smsFn, /\bfrom\b|sender|StatusCallback|callbackUrl/i);

  // No verified ClickSend delivery callback exists, so tracking must be
  // reported as unconfigured and acceptance must never imply delivery.
  assert.match(helper, /deliveryTrackingConfigured: false/);
  assert.match(route, /sendSmsCampaign\(campaign, recipient\)/);
  assert.match(route, /Delivered will appear only after a verified provider callback confirms it/);
  assert.doesNotMatch(route, /mark.*Delivered.*provider API success/i);

  // The Twilio webhook was removed with the swap, and no ClickSend webhook is
  // faked without a safe verified callback path.
  await assert.rejects(read("app/api/webhooks/twilio/status/route.ts"));
  assert.doesNotMatch(helper, /verifyTwilioSignature|createHmac\("sha1"|timingSafeEqual|webhooks\/twilio|webhooks\/clicksend/);
});

test("provider configuration is surfaced truthfully without enabling sending", async () => {
  const [tools, connections] = await Promise.all([
    read("lib/mara/tools.ts"),
    read("app/app/(shell)/connections/page.tsx"),
  ]);

  assert.match(tools, /providerConfig/);
  assert.match(tools, /does not enable sending/);
  assert.match(tools, /sendingAvailable: false/);
  assert.match(connections, /Configured on server/);
  assert.match(connections, /Approved campaigns can send to one real recipient/);
  assert.match(connections, /Delivered requires the verified webhook/);
  assert.match(connections, /Delivered requires verified status callbacks/);
  assert.match(connections, /ClickSend/);
  assert.doesNotMatch(connections, /Twilio/);
});
