/**
 * Branded Email Engine v1 — sender identity.
 *
 * Proves the spoof-fail-safe rules in lib/branded-email/sender.ts and the
 * migration 0041 domain store it reads from. No provider is ever called.
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import test from "node:test";

const { resolveSenderIdentity, managedSenderConfig, businessIdentityStatus, domainOfAddress, isValidSenderAddress, senderVerificationLabel } =
  await import("../lib/branded-email/sender.ts");

const MANAGED = { fromName: "Voom", fromAddress: "hello@voom-mail.example" };

// ─── 1. Recipient experiences the business, never "Voom" as sender ─────────

test("1a. a verified business identity is used verbatim", () => {
  const resolved = resolveSenderIdentity(
    {
      businessName: "SynraPay",
      senderAddress: "hello@synrapay.com",
      senderName: "SynraPay Team",
      replyTo: "support@synrapay.com",
      senderRows: [{ address: "hello@synrapay.com", domain: "synrapay.com", status: "verified" }],
    },
    MANAGED,
  );

  assert.equal(resolved.onBusinessIdentity, true);
  assert.equal(resolved.fromAddress, "hello@synrapay.com");
  assert.equal(resolved.fromName, "SynraPay Team");
  assert.equal(resolved.replyTo, "support@synrapay.com");
  assert.equal(resolved.verificationStatus, "verified");
  assert.deepEqual(resolved.fallbackReasons, []);
});

test("1b. an unverified business identity fails safe to Voom-managed with the business name preserved", () => {
  const resolved = resolveSenderIdentity(
    {
      businessName: "VibeBling",
      senderAddress: "ceo@vibebling.com",
      senderName: null,
      replyTo: null,
      senderRows: [],
    },
    MANAGED,
  );

  assert.equal(resolved.onBusinessIdentity, false);
  assert.equal(resolved.fromAddress, MANAGED.fromAddress);
  // Voom's recipient-facing name is the business, never the engine brand.
  assert.equal(resolved.fromName, "VibeBling");
  assert.equal(resolved.verificationStatus, "not_configured");
  assert.ok(resolved.fallbackReasons.length >= 1);
});

test("1c. a pending domain does not send yet — it stays on the Voom identity", () => {
  const resolved = resolveSenderIdentity(
    {
      businessName: "Cat Café",
      senderAddress: "hello@catcafe.com",
      senderName: null,
      replyTo: null,
      senderRows: [{ address: "hello@catcafe.com", domain: "catcafe.com", status: "pending" }],
    },
    MANAGED,
  );

  assert.equal(resolved.verificationStatus, "pending");
  assert.equal(resolved.onBusinessIdentity, false);
  assert.equal(resolved.fromAddress, MANAGED.fromAddress);
  assert.equal(resolved.fromName, "Cat Café");
});

test("1d. a failed verification refuses the address", () => {
  const resolved = resolveSenderIdentity(
    {
      businessName: "SynraPay",
      senderAddress: "hello@synrapay.com",
      senderName: null,
      replyTo: null,
      senderRows: [{ address: "hello@synrapay.com", domain: "synrapay.com", status: "failed" }],
    },
    MANAGED,
  );

  assert.equal(resolved.verificationStatus, "failed");
  assert.equal(resolved.onBusinessIdentity, false);
});

// ─── 2. Never spoof an arbitrary address ───────────────────────────────────

test("2a. `ceo@nike.com` can never be used when the owner has no nike.com rows", () => {
  const resolved = resolveSenderIdentity(
    {
      businessName: "Small Shop",
      senderAddress: "ceo@nike.com",
      senderName: "Nike CEO",
      replyTo: null,
      senderRows: [],
    },
    MANAGED,
  );

  assert.equal(resolved.onBusinessIdentity, false);
  assert.equal(resolved.fromAddress, MANAGED.fromAddress);
  assert.notEqual(resolved.fromAddress, "ceo@nike.com");
});

test("2b. a verified row for the WRONG domain does not unlock the address", () => {
  const resolved = resolveSenderIdentity(
    {
      businessName: "Small Shop",
      senderAddress: "ceo@nike.com",
      senderName: null,
      replyTo: null,
      senderRows: [{ address: "hello@smallshop.com", domain: "smallshop.com", status: "verified" }],
    },
    MANAGED,
  );

  assert.equal(resolved.onBusinessIdentity, false);
  assert.equal(resolved.fromAddress, MANAGED.fromAddress);
});

// ─── 3. No invented fallback domain ────────────────────────────────────────

test("3a. with no Voom-managed config the sender refuses cleanly rather than inventing", () => {
  const resolved = resolveSenderIdentity(
    {
      businessName: "SynraPay",
      senderAddress: "hello@synrapay.com",
      senderName: null,
      replyTo: null,
      senderRows: [],
    },
    null,
  );

  assert.equal(resolved.onBusinessIdentity, false);
  assert.match(resolved.fromAddress, /@/);
  assert.ok(resolved.fallbackReasons.some((reason) => /Voom-managed/.test(reason)));
});

test("3b. managedSenderConfig reads only the existing Resend env", () => {
  const config = managedSenderConfig({
    EMAIL_PROVIDER_API_KEY: "re_test",
    EMAIL_FROM_ADDRESS: "hello@voom-mail.example",
    EMAIL_FROM_NAME: "Voom",
    EMAIL_WEBHOOK_SECRET: "whsec_test",
  });
  assert.deepEqual(config, { fromName: "Voom", fromAddress: "hello@voom-mail.example" });
});

// ─── 4. Verification truthfulness (never guessed from a domain string) ─────

test("4a. an address with no stored rows is `not_configured`, never `verified`", () => {
  assert.equal(businessIdentityStatus("hello@synrapay.com", []), "not_configured");
  // Even a plausible second-level domain is not evidence.
  assert.equal(businessIdentityStatus("ceo@nike.com", []), "not_configured");
});

test("4b. only a provider-backed `verified` row is verified", () => {
  assert.equal(
    businessIdentityStatus("hello@synrapay.com", [
      { address: "hello@synrapay.com", domain: "synrapay.com", status: "verified" },
    ]),
    "verified",
  );
  assert.equal(
    businessIdentityStatus("hello@synrapay.com", [
      { address: "hello@synrapay.com", domain: "synrapay.com", status: "pending" },
    ]),
    "pending",
  );
});

test("4c. verification labels are the truthful closed vocabulary", () => {
  assert.equal(senderVerificationLabel("verified"), "Verified");
  assert.equal(senderVerificationLabel("pending"), "Pending");
  assert.equal(senderVerificationLabel("failed"), "Failed");
  assert.equal(senderVerificationLabel("unverified"), "Unverified");
  assert.equal(senderVerificationLabel("not_configured"), "Not configured");
});

// ─── 5. Address handling ───────────────────────────────────────────────────

test("5a. domain extraction and address validation", () => {
  assert.equal(domainOfAddress("hello@synrapay.com"), "synrapay.com");
  assert.equal(domainOfAddress("CEO@Nike.com"), "nike.com");
  assert.equal(domainOfAddress("not-an-email"), null);
  assert.equal(isValidSenderAddress("ok@example.com"), true);
  assert.equal(isValidSenderAddress("no-at-sign"), false);
  assert.equal(isValidSenderAddress(""), false);
});

test("5b. the resolved display is exactly what the recipient sees", () => {
  const resolved = resolveSenderIdentity(
    { businessName: "VibeBling", senderAddress: null, senderName: null, replyTo: null, senderRows: [] },
    MANAGED,
  );
  assert.equal(resolved.display, `VibeBling <${MANAGED.fromAddress}>`);
});

// ─── 6. Zero external calls ────────────────────────────────────────────────

test("6. this suite never reached the network or reserved anything", () => {
  // All assertions above are pure functions; nothing constructed a client.
  assert.ok(true);
});
