import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("Email provider secrets remain server-only and SMS secrets are gone", async () => {
  const env = await read(".env.example");
  for (const name of [
    "EMAIL_PROVIDER_API_KEY",
    "EMAIL_FROM_ADDRESS",
    "EMAIL_FROM_NAME",
    "EMAIL_WEBHOOK_SECRET",
  ]) {
    assert.match(env, new RegExp(`^${name}=$`, "m"));
    assert.doesNotMatch(env, new RegExp(`NEXT_PUBLIC_${name}`));
  }
  // SMS (ClickSend) was removed from the product: no env vars are documented.
  assert.doesNotMatch(env, /CLICKSEND_/);

  const [emailConfig, emailClient, emailIndex, campaigns] = await Promise.all([
    read("lib/email/config.ts"),
    read("lib/email/client.ts"),
    read("lib/email/index.ts"),
    read("app/app/(shell)/campaigns/page.tsx"),
  ]);

  for (const source of [emailConfig, emailClient, emailIndex]) {
    assert.match(source, /import "server-only"/);
  }

  assert.doesNotMatch(campaigns, /EMAIL_PROVIDER_API_KEY|EMAIL_FROM_ADDRESS|EMAIL_FROM_NAME|EMAIL_WEBHOOK_SECRET|CLICKSEND_USERNAME|CLICKSEND_API_KEY/);
});

test("the SMS provider module is fully removed and no SMS client is importable", async () => {
  // lib/sms (ClickSend config/client/sender) was deleted wholesale; the
  // retired channel keeps its historical database rows only.
  await Promise.all([
    "lib/sms/config.ts",
    "lib/sms/client.ts",
    "lib/sms/core.ts",
    "lib/sms/index.ts",
  ].map((path) => assert.rejects(read(path), undefined, `${path} must not exist`)));
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

test("SMS execution is gone: no sender, no invented provider, retired availability", async () => {
  const [helper, route] = await Promise.all([
    read("lib/voom/campaign-delivery.ts"),
    read("app/api/voom/campaigns/[id]/delivery/route.ts"),
  ]);

  // No SMS send function or ClickSend client exists in the delivery helper.
  assert.doesNotMatch(helper, /sendSmsCampaign|createClickSend|clickSendSmsSendPath|provider: "clicksend"/);
  assert.doesNotMatch(helper, /@\/lib\/sms/);

  // The retired availability branch is explicitly unconfigured.
  assert.match(helper, /provider: "retired"/);
  assert.match(helper, /label: kind === "multi" \? "Automated campaign" : "SMS \(retired\)"/);

  // The delivery route refuses SMS/multi campaigns with 410 and never
  // invokes an SMS sender. Email truthfulness is unchanged.
  assert.doesNotMatch(route, /sendSmsCampaign/);
  assert.match(route, /campaign\.kind === "sms" \|\| campaign\.kind === "multi"/);
  assert.match(route, /\{ status: 410 \}/);
  assert.match(route, /Delivered will appear only after a verified provider callback confirms it/);
  assert.doesNotMatch(route, /mark.*Delivered.*provider API success/i);

  // No SMS webhook was ever faked.
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
  assert.match(connections, /Approved campaign emails send only through an explicit send action/);
  assert.match(connections, /Delivered requires the verified webhook/);
  // The active product is Instagram + email only; SMS is named as removed.
  assert.match(connections, /campaigns run on Instagram and email/);
  assert.doesNotMatch(connections, /ClickSend|Twilio/);
});
