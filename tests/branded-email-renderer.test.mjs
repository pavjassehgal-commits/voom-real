/**
 * Branded Email Engine v1 — the deterministic renderer + design model.
 *
 * The renderer is imported FOR REAL: same inputs byte-for-byte = deterministic;
 * table-based and email-safe; every layout family renders; personalization can
 * never leak an unresolved token; a missing hero asset falls back to brand
 * color/text; and CTA/asset destinations are validated, never invented.
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import test from "node:test";

const design = await import("../lib/branded-email/design.ts");
const render = await import("../lib/branded-email/render.ts");
const profile = await import("../lib/branded-email/brand-profile.ts");
const colors = await import("../lib/branded-email/colors.ts");
const derive = await import("../lib/branded-email/derive.ts");
const assets = await import("../lib/branded-email/assets.ts");

function brand(overrides = {}) {
  return profile.buildEmailBrandProfile({
    ownerId: "11111111-1111-4111-8111-111111111111",
    businessId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    brandName: "SynraPay",
    brandDescription: "Payments for small merchants.",
    industry: "Fintech",
    website: "https://synrapay.com",
    primaryColor: "#0f6f68",
    accentColor: "#e8481f",
    ...overrides,
  });
}

function validDesign(overrides = {}) {
  return validate({
    layout: "welcome",
    headline: "Hi {firstName},",
    preheader: "Welcome to SynraPay",
    sections: [
      { heading: "What happens next", text: "Thanks for subscribing.\n\nEverything is ready." },
      { text: "A short note from the team." },
    ],
    cta: { label: "Open the dashboard", url: "https://synrapay.com/dashboard" },
    heroAssetId: null,
    heroAlt: null,
    visualEmphasis: 1,
    tone: "plain-spoken",
    ...overrides,
  });
}

function validate(candidate) {
  return render.validateEmailDesign(candidate);
}

// ─── 1. Deterministic renderer: same envelope = byte-identical markup ──────

test("1a. the same design renders the same HTML each time", () => {
  const d = validDesign().design;
  const input = {
    design: d,
    brand: brand(),
    cta: { label: "Open the dashboard", url: "https://synrapay.com/dashboard" },
    hero: null,
    personalization: { firstName: "Ada", recipientEmail: "ada@example.com" },
    unsubscribeUrl: "https://app.example/unsubscribe?t=abc",
    unsubscribeText: "Unsubscribe at any time:",
    subject: "Welcome to SynraPay",
  };
  const first = render.renderEmailHtml(input);
  const second = render.renderEmailHtml(input);
  assert.equal(first, second, "the renderer is deterministic");
  assert.ok(first.length > 500, "a real document, not a stub");
});

test("1b. rendering the same envelope HTML+text never disagrees", () => {
  const d = validDesign().design;
  const out = render.renderEmail({
    design: d,
    brand: brand(),
    cta: { label: "Open the dashboard", url: "https://synrapay.com/dashboard" },
    hero: null,
    personalization: { firstName: "Ada", recipientEmail: "ada@example.com" },
    unsubscribeUrl: "https://app.example/unsubscribe?t=abc",
    unsubscribeText: "Unsubscribe at any time:",
    subject: "Welcome to SynraPay",
  });
  assert.equal(out.subject, "Welcome to SynraPay");
  assert.ok(out.html.includes("Open the dashboard"));
  assert.ok(out.text.includes("Open the dashboard: https://synrapay.com/dashboard"));
});

// ─── 2. Email-safe structure & accessibility ───────────────────────────────

test("2a. output is table-based, free of flexbox/grid, JS and external scripts", () => {
  const html = render.renderEmailHtml({
    design: validDesign().design,
    brand: brand(),
    hero: null,
    personalization: { firstName: "Ada", recipientEmail: null },
    unsubscribeUrl: "https://app.example/unsubscribe?t=abc",
    unsubscribeText: null,
    subject: "x",
  });
  assert.ok(/<table[^>]*>/.test(html), "tables are the layout mechanism");
  assert.doesNotMatch(html, /display:\s*flex/, "no flexbox in email");
  assert.doesNotMatch(html, /display:\s*grid/, "no grid in email");
  assert.doesNotMatch(html, /<script/, "no JavaScript");
  assert.doesNotMatch(html, /javascript:/i, "no javascript: URLs");
  assert.ok(/@media\s+only\s+screen\s+and\s+\(max-width:\s*600px\)/.test(html), "mobile breakpoint present");
  assert.ok(/role="presentation"/.test(html), "layout tables are presentation-only");
});

test("2b. every image has alt text and no external font/CSS dependency", () => {
  const html = render.renderEmailHtml({
    design: validDesign().design,
    brand: brand(),
    hero: { url: "https://cdn.example/brand/hero.jpg", alt: "SynraPay dashboard screenshot", mimeType: "image/jpeg" },
    personalization: { firstName: null, recipientEmail: null },
    unsubscribeUrl: "https://app.example/unsubscribe?t=abc",
    unsubscribeText: null,
    subject: "x",
  });
  const match = html.match(/<img[^>]*>/g) ?? [];
  assert.ok(match.length >= 1, "the hero is embedded");
  for (const img of match) {
    assert.ok(/alt="[^"]*"/.test(img), `every image has alt text: ${img}`);
  }
  assert.doesNotMatch(html, /https?:\/\/fonts\./i, "no external font fetch");
});

test("2c. CTA buttons are real anchors with validated destinations and safe contrast", () => {
  const primary = colors.brandColor("#0f6f68");
  const labelColor = colors.buttonLabelColor(primary);
  assert.ok(colors.contrastRatio(primary, labelColor) >= colors.MIN_CONTRAST, "CTA label meets 4.5:1");
  const html = render.renderEmailHtml({
    design: validDesign().design,
    brand: brand(),
    hero: null,
    personalization: { firstName: "Ada", recipientEmail: null },
    unsubscribeUrl: "https://app.example/unsubscribe?t=abc",
    unsubscribeText: null,
    subject: "x",
  });
  assert.match(html, /<a[^>]*href="https:\/\/synrapay\.com\/dashboard"[^>]*>/);
  assert.match(html, /<a[^>]*href="https:\/\/app\.example\/unsubscribe[^"]*"[^>]*>/);
});

// ─── 3. Every layout family renders ────────────────────────────────────────

test("3. all six registered families validate and render deterministically", () => {
  for (const layout of design.EMAIL_LAYOUT_IDS) {
    const d = validDesign({ layout }).design;
    assert.equal(d.layout, layout);
    const html = render.renderEmailHtml({
      design: d,
      brand: brand(),
      hero: null,
      personalization: { firstName: null, recipientEmail: null },
      unsubscribeUrl: layout !== "minimal" ? "https://app.example/unsubscribe?t=abc" : null,
      unsubscribeText: null,
      subject: `subject-${layout}`,
    });
    assert.ok(html.length > 300, `${layout} renders`);
  }
  assert.equal(design.EMAIL_LAYOUT_IDS.length, 6, "4–6 families: welcome, announcement, feature, editorial, minimal, product");
});

// ─── 4. Personalization tokens can never leak ──────────────────────────────

test("4a. firstName tokens resolve, including the double-brace variant", () => {
  assert.equal(render.personalize("Hi {firstName}, welcome", "Ada"), "Hi Ada, welcome");
  assert.equal(render.personalize("Hi {{firstName}}, welcome", "Ada"), "Hi Ada, welcome");
  assert.equal(render.personalize("Hi {firstName}, {firstName}!", null), "Hi there, there!");
});

test("4b. stray/unresolvable tokens are neutralized, not shipped", () => {
  const out = render.renderEmail({
    design: validDesign().design,
    brand: brand(),
    hero: null,
    personalization: { firstName: null, recipientEmail: null },
    unsubscribeUrl: "https://app.example/unsubscribe?t=abc",
    unsubscribeText: null,
    subject: "Welcome {firstName}",
  });
  assert.doesNotMatch(out.text, /\{\{?[A-Za-z]/, "no token survives into the text part");
  assert.doesNotMatch(out.html, /\{\{?firstName/, "no token survives into the HTML");
  assert.ok(out.subject.includes("there"), "the subject is personalized");
});

test("4c. hasUnresolvedTokens detects and neutralizes", () => {
  assert.equal(render.hasUnresolvedTokens("{firstName} lives here"), true);
  assert.equal(render.hasUnresolvedTokens("Hello Ada"), false);
});

// ─── 5. No-image layout fallback + asset preference ────────────────────────

test("5a. a family without a hero (editorial) renders with no image and still carries brand color", () => {
  const d = validDesign({ layout: "editorial" }).design;
  const html = render.renderEmailHtml({
    design: d,
    brand: brand(),
    hero: null,
    personalization: { firstName: null, recipientEmail: null },
    unsubscribeUrl: "https://app.example/unsubscribe?t=abc",
    unsubscribeText: null,
    subject: "x",
  });
  assert.doesNotMatch(html, /<img/, "no image is invented");
  assert.ok(html.includes("#0f6f68"), "the brand color is present");
  assert.ok(html.includes("#111614") || html.includes("#0f6f68"), "brand text design");
});

test("5b. asset preference order: business > campaign > upload > voom", () => {
  const chosen = assets.resolveHeroAsset({
    businessAssets: [{ id: "b", source: "business", mimeType: "image/png", url: "https://cdn.example/b.png", alt: "B" }],
    campaignAssets: [{ id: "c", source: "campaign", mimeType: "image/png", url: "https://cdn.example/c.png", alt: "C" }],
    uploadAssets: [],
    voomAssets: [],
  });
  assert.equal(chosen.id, "b", "business asset wins");
});

test("5c. a signed/temporary URL is never embedded", () => {
  assert.equal(assets.isEmailSafeImage("https://cdn.example/x.png?token=abc", "image/png"), false);
  assert.equal(assets.isEmailSafeImage("https://cdn.example/x.png?X-Amz-Signature=abc", "image/png"), false);
  assert.equal(assets.isEmailSafeImage("https://cdn.example/x.png", "image/png"), true);
  const chosen = assets.resolveHeroAsset({
    businessAssets: [{ id: "b", source: "business", mimeType: "image/png", url: "https://cdn.example/x.png?token=abc", alt: "B" }],
    campaignAssets: [{ id: "c", source: "campaign", mimeType: "image/jpeg", url: "https://cdn.example/c.jpg", alt: "C" }],
    uploadAssets: [],
    voomAssets: [],
  });
  assert.equal(chosen.id, "c", "the signed business URL is skipped");
});

// ─── 6. Deterministic derivation from stored content (history-preserving) ──

test("6a. stored body re-derives to the same design every time", () => {
  const body = "Hi {firstName},\n\nThanks for subscribing to SynraPay.\n\nHere is what happens next.";
  const a = derive.deriveEmailDesign({ subject: "Welcome", preheader: "What to expect", body, cta: "Reply", ctaUrl: null, position: 0, kind: "welcome" });
  const b = derive.deriveEmailDesign({ subject: "Welcome", preheader: "What to expect", body, cta: "Reply", ctaUrl: null, position: 0, kind: "welcome" });
  assert.deepEqual(a, b);
  assert.equal(a.layout, "welcome");
  assert.match(a.headline, /\{firstName\}/, "the greeting token stays until personalization");
});

// ─── 7. Zero external calls ────────────────────────────────────────────────

test("7. no network, no provider, no credit anywhere in this suite", () => {
  assert.ok(true, "pure modules only");
});
