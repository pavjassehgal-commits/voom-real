import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const contact = (overrides = {}) => ({
  email: null,
  phone: null,
  email_status: "unknown",
  sms_status: "unknown",
  ...overrides,
});

test("email eligibility requires a subscribed status", async () => {
  const { channelEligibleDestination } = await import("../lib/contacts/core.ts");
  assert.equal(channelEligibleDestination(contact({ email: "a@b.com", email_status: "unknown" }), "email"), null);
  assert.equal(channelEligibleDestination(contact({ email: "a@b.com", email_status: "unsubscribed" }), "email"), null);
  assert.equal(channelEligibleDestination(contact({ email: "a@b.com", email_status: "subscribed" }), "email"), "a@b.com");
});

test("email eligibility requires a valid email address", async () => {
  const { channelEligibleDestination } = await import("../lib/contacts/core.ts");
  assert.equal(channelEligibleDestination(contact({ email_status: "subscribed" }), "email"), null);
  assert.equal(channelEligibleDestination(contact({ email: "not-an-email", email_status: "subscribed" }), "email"), null);
  assert.equal(channelEligibleDestination(contact({ email: "a@b", email_status: "subscribed" }), "email"), null);
  assert.equal(channelEligibleDestination(contact({ email: "a@b.co", email_status: "subscribed" }), "email"), "a@b.co");
});

test("email destinations are normalized to lowercase before sending", async () => {
  const { channelEligibleDestination } = await import("../lib/contacts/core.ts");
  assert.equal(
    channelEligibleDestination(contact({ email: "  Emma.W@Example.COM ", email_status: "subscribed" }), "email"),
    "emma.w@example.com",
  );
});

test("sms eligibility requires a subscribed status", async () => {
  const { channelEligibleDestination } = await import("../lib/contacts/core.ts");
  assert.equal(channelEligibleDestination(contact({ phone: "+14155551234", sms_status: "unknown" }), "sms"), null);
  assert.equal(channelEligibleDestination(contact({ phone: "+14155551234", sms_status: "unsubscribed" }), "sms"), null);
  assert.equal(channelEligibleDestination(contact({ phone: "+14155551234", sms_status: "subscribed" }), "sms"), "+14155551234");
});

test("sms eligibility requires a valid E.164 phone number", async () => {
  const { channelEligibleDestination } = await import("../lib/contacts/core.ts");
  assert.equal(channelEligibleDestination(contact({ sms_status: "subscribed" }), "sms"), null);
  assert.equal(channelEligibleDestination(contact({ phone: "4155551234", sms_status: "subscribed" }), "sms"), null);
  assert.equal(channelEligibleDestination(contact({ phone: "+0415", sms_status: "subscribed" }), "sms"), null);
  assert.equal(channelEligibleDestination(contact({ phone: "+14155551234567 89", sms_status: "subscribed" }), "sms"), null);
});

test("eligibility on the other channel never leaks across channels", async () => {
  const { channelEligibleDestination } = await import("../lib/contacts/core.ts");
  const c = contact({ email: "a@b.com", email_status: "subscribed", phone: "+14155551234", sms_status: "unsubscribed" });
  assert.equal(channelEligibleDestination(c, "email"), "a@b.com");
  assert.equal(channelEligibleDestination(c, "sms"), null);
});

test("computeChannelEligibility counts excluded unknown/unsubscribed contacts", async () => {
  const { computeChannelEligibility } = await import("../lib/contacts/core.ts");
  const contacts = [
    contact({ email: "yes@x.com", email_status: "subscribed" }),
    contact({ email: "unknown@x.com", email_status: "unknown" }),
    contact({ email: "gone@x.com", email_status: "unsubscribed" }),
    contact({ phone: "+14155551234", email_status: "subscribed" }), // subscribed but no email
  ];
  const result = computeChannelEligibility(contacts, "email");
  assert.equal(result.eligible.length, 1);
  assert.equal(result.excluded.length, 3);
  assert.equal(result.duplicates.length, 0);
  assert.equal(result.eligible[0].destination, "yes@x.com");
});

test("duplicate email destinations are deduped, first occurrence wins", async () => {
  const { computeChannelEligibility } = await import("../lib/contacts/core.ts");
  const contacts = [
    contact({ email: "dup@x.com", email_status: "subscribed" }),
    contact({ email: "DUP@x.com", email_status: "subscribed" }),
    contact({ email: "other@x.com", email_status: "subscribed" }),
  ];
  const result = computeChannelEligibility(contacts, "email");
  assert.equal(result.eligible.length, 2);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.excluded.length, 0);
  assert.deepEqual(
    result.eligible.map((e) => e.destination),
    ["dup@x.com", "other@x.com"],
  );
});

test("duplicate phone destinations are deduped", async () => {
  const { computeChannelEligibility } = await import("../lib/contacts/core.ts");
  const contacts = [
    contact({ phone: "+14155551234", sms_status: "subscribed" }),
    contact({ phone: "+14155551234", sms_status: "subscribed" }),
  ];
  const result = computeChannelEligibility(contacts, "sms");
  assert.equal(result.eligible.length, 1);
  assert.equal(result.duplicates.length, 1);
});

test("maskDestination hides the email local part and domain", async () => {
  const { maskDestination } = await import("../lib/contacts/core.ts");
  const masked = maskDestination("emma.wright@example.com");
  assert.equal(masked, "em…@e….com");
  assert.ok(!masked.includes("emma.wright"));
  assert.ok(!masked.includes("example"));
});

test("maskDestination hides nearly all phone digits", async () => {
  const { maskDestination } = await import("../lib/contacts/core.ts");
  const masked = maskDestination("+14155551234");
  assert.equal(masked, "+14••••34");
  assert.ok(!masked.includes("1555512"));
});

test("maskDestination never echoes the raw destination, even for edge cases", async () => {
  const { maskDestination } = await import("../lib/contacts/core.ts");
  assert.equal(maskDestination(""), "");
  assert.equal(maskDestination("ab@cd.io"), "ab…@c….io");
  const short = maskDestination("+12");
  assert.ok(!short.includes("12") || short.startsWith("+••••"));
  for (const raw of ["sara@test.org", "+971501234567"]) {
    assert.notEqual(maskDestination(raw), raw);
  }
});

test("eligibility helpers stay pure — no database or provider imports", async () => {
  const source = await read("lib/contacts/core.ts");
  assert.doesNotMatch(source, /import "server-only"/);
  assert.doesNotMatch(source, /@supabase/);
  assert.doesNotMatch(source, /createResendClient|createClickSendClient|fetch\(/);
});
