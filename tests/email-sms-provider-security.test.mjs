import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const twilioAccountSid = "AC11111111111111111111111111111111";
const twilioMessagingServiceSid = "MG22222222222222222222222222222222";

test("Email and SMS provider secrets remain server-only", async () => {
  const env = await read(".env.example");
  for (const name of [
    "EMAIL_PROVIDER_API_KEY",
    "EMAIL_FROM_ADDRESS",
    "EMAIL_FROM_NAME",
    "EMAIL_WEBHOOK_SECRET",
    "SMS_PROVIDER_API_KEY",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_MESSAGING_SERVICE_SID",
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

  assert.doesNotMatch(campaigns, /EMAIL_PROVIDER_API_KEY|EMAIL_FROM_ADDRESS|EMAIL_FROM_NAME|EMAIL_WEBHOOK_SECRET|SMS_PROVIDER_API_KEY|TWILIO_ACCOUNT_SID|TWILIO_MESSAGING_SERVICE_SID/);
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

test("Twilio configuration validates required server env and exposes truthful availability", async () => {
  const { SmsProviderConfigurationError, getTwilioAvailability, readTwilioConfig, requireTwilioConfig } = await import("../lib/sms/core.ts");

  const partial = getTwilioAvailability({
    SMS_PROVIDER_API_KEY: "twilio_secret",
    TWILIO_ACCOUNT_SID: twilioAccountSid,
  });
  assert.equal(partial.provider, "twilio");
  assert.equal(partial.configured, false);
  assert.deepEqual(partial.missingEnv, ["TWILIO_MESSAGING_SERVICE_SID"]);
  assert.equal(readTwilioConfig({
    SMS_PROVIDER_API_KEY: "twilio_secret",
    TWILIO_ACCOUNT_SID: twilioAccountSid,
    TWILIO_MESSAGING_SERVICE_SID: "invalid",
  }), null);

  const fullEnv = {
    SMS_PROVIDER_API_KEY: "twilio_secret",
    TWILIO_ACCOUNT_SID: twilioAccountSid,
    TWILIO_MESSAGING_SERVICE_SID: twilioMessagingServiceSid,
  };
  const availability = getTwilioAvailability(fullEnv);
  assert.equal(availability.configured, true);
  assert.deepEqual(availability.missingEnv, []);

  assert.deepEqual(readTwilioConfig(fullEnv), {
    provider: "twilio",
    apiKey: "twilio_secret",
    accountSid: twilioAccountSid,
    messagingServiceSid: twilioMessagingServiceSid,
    apiBaseUrl: "https://api.twilio.com",
    apiVersion: "2010-04-01",
  });

  assert.throws(() => requireTwilioConfig({}), (error) => {
    assert.ok(error instanceof SmsProviderConfigurationError);
    assert.equal(error.message, "sms_provider_not_configured");
    assert.equal(error.availability.configured, false);
    assert.match(error.availability.missingEnv.join(","), /SMS_PROVIDER_API_KEY/);
    return true;
  });
});

test("Twilio client uses injected fetch with basic auth and form encoding", async () => {
  const { createTwilioApiClient } = await import("../lib/sms/core.ts");

  let call = null;
  const client = createTwilioApiClient({
    provider: "twilio",
    apiKey: "twilio_secret",
    accountSid: twilioAccountSid,
    messagingServiceSid: twilioMessagingServiceSid,
    apiBaseUrl: "https://api.twilio.com",
    apiVersion: "2010-04-01",
  }, {
    timeoutMs: 4321,
    fetch: async (input, init) => {
      call = { url: String(input), init };
      return new Response(JSON.stringify({ sid: "SM123" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const response = await client.postForm("Messages.json", {
    MessagingServiceSid: twilioMessagingServiceSid,
    To: "+15551234567",
    Body: "Hello from Voom",
  });
  assert.equal(response.status, 201);
  assert.equal(call?.url, `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Messages.json`);
  assert.equal(call?.init?.method, "POST");
  assert.equal(call?.init?.cache, "no-store");
  assert.ok(call?.init?.signal instanceof AbortSignal);

  const headers = new Headers(call?.init?.headers);
  assert.equal(headers.get("Authorization"), `Basic ${Buffer.from(`${twilioAccountSid}:twilio_secret`, "utf8").toString("base64")}`);
  assert.equal(headers.get("Content-Type"), "application/x-www-form-urlencoded;charset=utf-8");
  assert.equal(headers.get("Accept"), "application/json");

  const body = new URLSearchParams(String(call?.init?.body));
  assert.equal(body.get("MessagingServiceSid"), twilioMessagingServiceSid);
  assert.equal(body.get("To"), "+15551234567");
  assert.equal(body.get("Body"), "Hello from Voom");
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
});
