import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

function clientReturning({ ok = true, status = 200, body = { id: "msg_1", last_event: "accepted" } } = {}) {
  const calls = [];
  return {
    calls,
    client: {
      provider: "resend",
      config: { provider: "resend" },
      async post(path, payload, init) {
        calls.push({ path, payload, headers: init?.headers ?? {} });
        return new Response(JSON.stringify(body), { status, statusText: ok ? "OK" : "Error" });
      },
    },
  };
}

const sendInput = {
  from: "Voom <hello@example.com>",
  to: "customer@example.com",
  replyTo: "support@example.com",
  subject: "A useful update",
  preheader: "A short preview",
  html: "<p>Hello</p>",
  text: "Hello",
  idempotencyKey: "send-1",
};

test("Resend adapter maps the provider-neutral send and preserves idempotency", async () => {
  const { createResendDeliveryProvider } = await import("../lib/email/providers/resend.ts");
  const fake = clientReturning();
  const result = await createResendDeliveryProvider(fake.client).send(sendInput);

  assert.equal(result.ok, true);
  assert.equal(result.provider, "resend");
  assert.equal(result.providerMessageId, "msg_1");
  assert.equal(result.providerStatus, "accepted");
  assert.equal(result.errorKind, null);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].path, "emails");
  assert.deepEqual(fake.calls[0].payload.to, [sendInput.to]);
  assert.equal(fake.calls[0].payload.reply_to, sendInput.replyTo);
  assert.equal(fake.calls[0].headers["Idempotency-Key"], sendInput.idempotencyKey);
});

test("provider rejection and ambiguous acceptance are normalized without fallback", async () => {
  const { createResendDeliveryProvider } = await import("../lib/email/providers/resend.ts");

  const rejected = clientReturning({ ok: false, status: 422, body: { message: "Rejected" } });
  const rejectedResult = await createResendDeliveryProvider(rejected.client).send(sendInput);
  assert.equal(rejectedResult.ok, false);
  assert.equal(rejectedResult.errorCode, "HTTP_422");
  assert.equal(rejectedResult.errorKind, "rejected");
  assert.equal(rejectedResult.ambiguous, false);
  assert.equal(rejected.calls.length, 1);

  const ambiguous = clientReturning({ body: { last_event: "accepted" } });
  const ambiguousResult = await createResendDeliveryProvider(ambiguous.client).send(sendInput);
  assert.equal(ambiguousResult.ok, false);
  assert.equal(ambiguousResult.errorCode, "provider_outcome_ambiguous");
  assert.equal(ambiguousResult.errorKind, "ambiguous");
  assert.equal(ambiguousResult.ambiguous, true);
  assert.equal(ambiguous.calls.length, 1, "an ambiguous outcome is never retried through another provider");
});

test("Resend webhook events normalize into provider-independent delivery states", async () => {
  const { normalizeResendWebhook } = await import("../lib/email/providers/resend.ts");
  const headers = new Headers({ "svix-id": "evt_1" });

  const opened = normalizeResendWebhook({
    type: "email.opened",
    created_at: "2026-10-13T08:00:00.000Z",
    data: { email_id: "msg_1" },
  }, headers);
  assert.deepEqual(opened, {
    provider: "resend",
    providerMessageId: "msg_1",
    eventId: "evt_1",
    eventType: "email.opened",
    status: "opened",
    receivedAt: "2026-10-13T08:00:00.000Z",
  });

  const unknown = normalizeResendWebhook({ type: "email.future_event", data: { email_id: "msg_2" } }, headers);
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.eventType, "email.future_event", "the raw event remains available for audit");
});

test("the route is a thin verified adapter and campaign delivery is provider-independent", async () => {
  const [route, delivery] = await Promise.all([
    read("app/api/webhooks/resend/route.ts"),
    read("lib/voom/campaign-delivery.ts"),
  ]);
  assert.match(route, /verifyResendWebhook/);
  assert.match(route, /normalizeResendWebhook/);
  assert.match(route, /recordDeliveryFromWebhook/);
  assert.doesNotMatch(delivery, /standardwebhooks|new Webhook/);
});

