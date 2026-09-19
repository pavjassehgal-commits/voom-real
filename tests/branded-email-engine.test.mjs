/**
 * Branded Email Engine — behavioural regression tests.
 *
 * Real code, no network: the Resend client is injected (and every `fetch`
 * throws if anything tries the wire), the provider's domain state is
 * injected, and the storage boundary is a fake. These tests pin the things
 * a recipient actually experiences: who the email comes from, that Voom can
 * never spoof an unverified domain, that the renderer output is safe and
 * professional, that MARA can only express validated design, that personal-
 * ization never leaks tokens, that unsubscribe is real and tamper-proof,
 * that assets are owner-scoped, and that the pre-send guard fails closed.
 */

import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import test from "node:test";

let fetchCalls = 0;
test.before(() => {
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error(`network call attempted (${fetchCalls})`);
  };
});
test.after(() => {
  delete globalThis.fetch;
});

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const ENV = {
  EMAIL_PROVIDER_API_KEY: "re_test_placeholder",
  EMAIL_FROM_ADDRESS: "hello@voommanaged.example",
  EMAIL_FROM_NAME: "Voom",
  EMAIL_WEBHOOK_SECRET: "whsec_test",
  EMAIL_UNSUBSCRIBE_SECRET: "branded_test_secret",
};
const savedEnv = {};
test.before(() => {
  for (const [name, value] of Object.entries(ENV)) {
    savedEnv[name] = process.env[name];
    process.env[name] = value;
  }
});
test.after(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

// ─── Fakes ───────────────────────────────────────────────────────────────────

/** Offline Resend stand-in: records calls, never touches the wire. */
function createProvider({ ok = true, status = 200 } = {}) {
  const calls = [];
  return {
    calls,
    client: {
      config: { fromName: ENV.EMAIL_FROM_NAME, fromAddress: ENV.EMAIL_FROM_ADDRESS },
      // No `request` method on purpose: sender verification must fail safe
      // instead of hitting the provider.
      async post(path, body, init) {
        calls.push({ path, body, headers: init?.headers ?? {} });
        return {
          ok,
          status,
          async text() {
            return ok
              ? JSON.stringify({ id: `msg_${calls.length}`, last_event: "accepted" })
              : JSON.stringify({ message: "The provider refused the send." });
          },
        };
      },
    },
  };
}

/** In-memory admin client covering the branded engine's read surface. */
function createAdmin(tables = {}) {
  const store = structuredClone(tables);
  const rpcCalls = [];
  const objectStore = new Map();

  function rowsFor(table, filters) {
    return (store[table] ?? []).filter((row) =>
      filters.every(([column, value]) => String(row[column]) === String(value)),
    );
  }

  const admin = {
    rpcCalls,
    objectStore,
    from(table) {
      let filters = [];
      let limitValue = null;
      const query = {
        select() {
          return query;
        },
        eq(column, value) {
          filters.push([column, value]);
          return query;
        },
        neq(column, value) {
          filters.push([column, value]);
          return query;
        },
        order() {
          return query;
        },
        limit(n) {
          limitValue = n;
          return query;
        },
        async maybeSingle() {
          const rows = rowsFor(table, filters);
          return { data: limitValue ? rows.slice(0, limitValue)[0] ?? null : rows[0] ?? null, error: null };
        },
        async single() {
          const rows = rowsFor(table, filters);
          return { data: rows[0] ?? null, error: rows.length === 0 ? { message: "PGRST116" } : null };
        },
      };
      return query;
    },
    rpc(name, args) {
      rpcCalls.push({ name, args });
      const result = applyRpc(name, args);
      return {
        data: result,
        error: result === null ? { message: "rpc_denied" } : null,
        single: async () => ({
          data: result,
          error: result === null ? { message: "rpc_denied" } : null,
        }),
      };
    },
  };
  return admin;

  function applyRpc(name, args) {
    switch (name) {
      case "create_email_asset": {
        const row = {
          id: `asset-${(store.voom_email_assets ?? []).length + 1}`,
          owner_user_id: args.p_owner_user_id,
          business_id: null,
          public_path: args.p_payload.publicPath,
          public_url: args.p_payload.publicUrl,
          mime_type: args.p_payload.mimeType,
          byte_size: args.p_payload.byteSize,
          alt_text: args.p_payload.altText,
          width: args.p_payload.width ?? null,
          height: args.p_payload.height ?? null,
          source_kind: args.p_payload.sourceKind,
          source_draft_id: args.p_payload.sourceDraftId ?? null,
          status: "ready",
        };
        (store.voom_email_assets ??= []).push(row);
        return row;
      }
      case "remove_email_asset": {
        const row = (store.voom_email_assets ?? []).find(
          (candidate) => candidate.id === args.p_asset_id && candidate.owner_user_id === args.p_owner_user_id,
        );
        if (!row) return null;
        row.status = "removed";
        return row;
      }
      case "upsert_email_identity": {
        const existing = (store.voom_email_identities ??= []).find(
          (candidate) => candidate.owner_user_id === args.p_owner_user_id,
        );
        const payload = args.p_payload ?? {};
        const row = existing ?? {
          id: "identity-1",
          owner_user_id: args.p_owner_user_id,
          business_id: null,
          verification_status: "not_configured",
          last_checked_at: null,
        };
        if (payload.displayName !== undefined) row.display_name = payload.displayName;
        if (payload.fromAddress !== undefined) row.from_address = payload.fromAddress;
        if (payload.replyTo !== undefined) row.reply_to = payload.replyTo;
        if (!existing) store.voom_email_identities.push(row);
        return row;
      }
      case "upsert_email_brand": {
        const existing = (store.voom_email_brands ??= []).find(
          (candidate) => candidate.owner_user_id === args.p_owner_user_id,
        );
        const payload = args.p_payload ?? {};
        const row = existing ?? {
          id: "brand-1",
          owner_user_id: args.p_owner_user_id,
          business_id: null,
          logo_asset_id: null,
          primary_color: null,
          secondary_color: null,
          website: null,
          footer_line: null,
        };
        for (const key of ["logoAssetId", "primaryColor", "secondaryColor", "website", "footerLine"]) {
          const column = { logoAssetId: "logo_asset_id", primaryColor: "primary_color", secondaryColor: "secondary_color", website: "website", footerLine: "footer_line" }[key];
          if (payload[key] !== undefined) row[column] = payload[key];
        }
        if (!existing) store.voom_email_brands.push(row);
        return row;
      }
      case "record_email_unsubscribe": {
        const list = (store.voom_email_unsubscribes ??= []);
        const existing = list.find(
          (candidate) => candidate.owner_user_id === args.p_owner_user_id && candidate.email === args.p_email,
        );
        if (existing) return { status: "already_unsubscribed" };
        const row = {
          id: `unsub-${list.length + 1}`,
          owner_user_id: args.p_owner_user_id,
          email: args.p_email,
          source: args.p_source,
          status: "unsubscribed",
        };
        list.push(row);
        (store.voom_email_suppressions ??= []).push({
          owner_user_id: args.p_owner_user_id,
          email: args.p_email,
          reason: "manual",
        });
        return { status: "unsubscribed" };
      }
      default:
        return null;
    }
  }
}

/** Fake storage boundary: in-memory objects, owner paths asserted. */
function createStorage() {
  const objects = new Map();
  const deleted = [];
  return {
    objects,
    deleted,
    async putObject(path, bytes, mimeType) {
      objects.set(path, { bytes, mimeType });
      return { path };
    },
    async getPrivateObject(path) {
      return objects.get(`private:${path}`)?.bytes ?? null;
    },
    async deleteObject(path) {
      deleted.push(path);
      objects.delete(path);
    },
    publicUrlFor(path) {
      return `https://cdn.example/storage/v1/object/public/voom-email-assets/${path}`;
    },
  };
}

const businessTables = {
  businesses: [{ id: "biz-1", owner_user_id: OWNER, brand_name: "SynraPay" }],
};

// ─── 1. Sender identity: never spoof, honest fallback ───────────────────────

test("1a. no identity configured → the Voom-managed address carries the business name", async () => {
  const { readBusinessSender } = await import("../lib/email/branded/identity.ts");
  const admin = createAdmin(businessTables);
  const read = await readBusinessSender(admin, OWNER, { providerDomains: new Map() });

  assert.equal(read.identity, null);
  assert.equal(read.verification.status, "not_configured");
  assert.equal(read.sender?.from, `${ENV.EMAIL_FROM_NAME} <${ENV.EMAIL_FROM_ADDRESS}>`);
});

test("1b. an unverified business address is NEVER used — even a verified-looking stored status", async () => {
  const { readBusinessSender } = await import("../lib/email/branded/identity.ts");
  const admin = createAdmin({
    ...businessTables,
    voom_email_identities: [
      {
        id: "identity-1",
        owner_user_id: OWNER,
        business_id: "biz-1",
        display_name: "SynraPay",
        from_address: "ceo@nike.com",
        reply_to: null,
        // A tampered/stale display hint: the resolver must ignore it.
        verification_status: "verified",
        last_checked_at: null,
      },
    ],
  });
  // The provider says nothing about this domain (empty map = answered, no domains known).
  const read = await readBusinessSender(admin, OWNER, { providerDomains: new Map() });

  assert.equal(read.verification.status, "unknown");
  // The managed ADDRESS with the business NAME — Voom's address, never Nike's.
  assert.equal(read.sender?.from, `SynraPay <${ENV.EMAIL_FROM_ADDRESS}>`, "falls back to the managed identity with the business name");
  assert.equal(read.sender?.mode, "voom_fallback");
  assert.ok(!String(read.sender?.from).includes("nike.com"), "no spoofing");
});

test("1c. a provider-verified domain → the business address is used, with the business name", async () => {
  const { readBusinessSender } = await import("../lib/email/branded/identity.ts");
  const admin = createAdmin({
    ...businessTables,
    voom_email_identities: [
      {
        id: "identity-1",
        owner_user_id: OWNER,
        business_id: "biz-1",
        display_name: "SynraPay",
        from_address: "hello@synrapay.com",
        reply_to: "support@synrapay.com",
        verification_status: "pending",
        last_checked_at: null,
      },
    ],
  });
  const read = await readBusinessSender(admin, OWNER, {
    providerDomains: new Map([["synrapay.com", "verified"]]),
  });

  assert.equal(read.verification.status, "verified");
  assert.equal(read.sender?.from, "SynraPay <hello@synrapay.com>");
  assert.equal(read.sender?.mode, "business_verified");
  assert.equal(read.sender?.replyTo, "support@synrapay.com");
});

test("1d. reply-to is honoured separately from From; it never becomes the sender", async () => {
  const { resolveBusinessSender } = await import("../lib/email/branded/identity.ts");
  const resolved = resolveBusinessSender({
    config: {
      provider: "resend",
      apiKey: "x",
      fromAddress: ENV.EMAIL_FROM_ADDRESS,
      fromName: ENV.EMAIL_FROM_NAME,
      webhookSecret: "x",
      apiBaseUrl: "https://api.resend.com",
    },
    identity: {
      id: "i",
      owner_user_id: OWNER,
      business_id: null,
      display_name: "SynraPay",
      from_address: null,
      reply_to: "replies@synrapay.com",
      verification_status: "not_configured",
      last_checked_at: null,
    },
    brandName: "SynraPay",
    providerDomains: new Map(),
  });
  assert.equal(resolved.from, `SynraPay <${ENV.EMAIL_FROM_ADDRESS}>`, "From stays the managed identity");
  assert.equal(resolved.replyTo, "replies@synrapay.com");
  assert.ok(!resolved.from.includes("replies@"), "reply-to can never become From");
});

test("1e. provider unreachable → fail-safe, and no network attempt is made", async () => {
  const { readBusinessSender } = await import("../lib/email/branded/identity.ts");
  const admin = createAdmin(businessTables);
  const provider = createProvider();
  // Inject the fake client (no request surface) — verification must not even try.
  const read = await readBusinessSender(admin, OWNER, { client: provider.client });
  assert.equal(read.verification.status, "not_configured");
  assert.equal(provider.calls.length, 0);
});

// ─── 2. The renderer: safe, responsive, professional ─────────────────────────

const baseDesign = (overrides = {}) => ({
  layout: "welcome",
  subject: "Welcome to SynraPay",
  preheader: "Your account is ready.",
  headline: "You're all set, {firstName}",
  sections: [
    { kind: "text", text: "SynraPay is your business's home for payments." },
    { kind: "text", text: "Connect your account and you're ready to accept your first payment." },
  ],
  cta: { label: "Open SynraPay", url: "https://synrapay.com/start" },
  heroAssetId: null,
  tone: "Confident and helpful",
  visualEmphasis: "brand",
  greeting: "Hi {firstName},",
  ...overrides,
});

function render(design, brandOverrides = {}, identityOverrides = {}) {
  const { renderEmail } = rendererModule;
  return renderEmail({
    design,
    brand: {
      name: "SynraPay",
      logo: null,
      primaryColor: "#1A73E8",
      secondaryColor: "#F4F1EC",
      footerLine: "SynraPay Ltd · 12 Marina Square, Dubai",
      website: "https://synrapay.com",
      ...brandOverrides,
    },
    identity: {
      fromName: "SynraPay",
      fromAddress: "hello@synrapay.com",
      replyTo: "support@synrapay.com",
      mode: "business_verified",
      ...identityOverrides,
    },
    unsubscribe: { url: "https://app.voom.example/unsubscribe?token=tok123", reason: "You subscribed to SynraPay updates." },
    assets: assetRefs,
    personalization: { firstName: "Ada", businessName: "SynraPay" },
  });
}

let rendererModule;
let assetRefs = [];

test("2a. HTML is table-based, inline-CSS, 600px, with a hidden preheader and no JS", async () => {
  rendererModule = await import("../lib/email/branded/renderer.ts");
  const rendered = render(baseDesign());
  const { html } = rendered;

  assert.ok(html.includes("<table role=\"presentation\""), "table-based layout");
  assert.ok(html.includes('width="600"'), "600px email container");
  assert.ok(html.includes("display:none"), "hidden preheader present");
  assert.ok(html.includes("Your account is ready."), "preheader content in the hidden block");
  assert.ok(!/<script/i.test(html), "no scripts");
  assert.ok(!/(?:^|[\s"'\/])on\w+\s*=/i.test(html), "no inline handlers");
  assert.ok(html.includes("@media only screen and (max-width: 620px)"), "mobile breakpoint");
  assert.equal(rendered.subject, "Welcome to SynraPay");
  assert.equal(rendered.preheader, "Your account is ready.");
});

test("2b. personalization is applied and tokens never reach the output", async () => {
  rendererModule ??= await import("../lib/email/branded/renderer.ts");
  const rendered = render(baseDesign(), {}, { fromName: "SynraPay" });
  assert.ok(rendered.html.includes("Hi Ada,"), "first name personalised in HTML");
  assert.ok(rendered.html.includes("all set, Ada"), "headline personalised (apostrophe is HTML-escaped)");
  assert.ok(rendered.text.startsWith("Hi Ada,"), "plain text starts with the personalised greeting");
  assert.ok(!rendered.html.includes("{firstName}"), "no raw token in HTML");
  assert.ok(!rendered.text.includes("{firstName}"), "no raw token in text");

  // No first name → a neutral greeting, never a raw token.
  const noName = rendererModule.renderEmail({
    design: baseDesign(),
    brand: { name: "SynraPay", logo: null, primaryColor: null, secondaryColor: null, footerLine: null, website: null },
    identity: { fromName: "SynraPay", fromAddress: "hello@synrapay.com", replyTo: null, mode: "voom_fallback" },
    unsubscribe: { url: "https://app.voom.example/unsubscribe?token=t", reason: "x" },
    assets: [],
    personalization: { firstName: null, businessName: "SynraPay" },
  });
  assert.ok(noName.text.includes("Hi there,"), "graceful fallback greeting");
  assert.ok(!noName.text.includes("{firstName}"));
});

test("2c. a real CTA is a designed button; without a destination it is a reply action, never a fake link", async () => {
  rendererModule ??= await import("../lib/email/branded/renderer.ts");

  const linked = render(baseDesign());
  assert.ok(linked.html.includes("https://synrapay.com/start"), "CTA links to its destination");
  assert.ok(/<a[^>]*href="https:\/\/synrapay\.com\/start"[^>]*>[^<]*Open SynraPay/i.test(linked.html), "designed button with the label");

  const unlinked = render(baseDesign({ cta: { label: "Talk to us", url: null } }));
  assert.ok(!/<a[^>]*href="javascript/i.test(unlinked.html));
  assert.ok(!unlinked.html.includes("https://synrapay.com/start"), "no invented destination");
  assert.ok(unlinked.html.includes("Talk to us"), "the label is still shown");
  assert.ok(unlinked.html.includes("Reply") || unlinked.html.includes("reply"), "reply-oriented action");
});

test("2d. images carry alt text; no image means no <img> at all", async () => {
  rendererModule ??= await import("../lib/email/branded/renderer.ts");
  assetRefs = [
    { assetId: "asset-1", url: "https://cdn.example/a.jpg", altText: "The SynraPay dashboard", mimeType: "image/jpeg", width: 1200, height: 800 },
  ];

  const withImage = render(baseDesign({ heroAssetId: "asset-1", visualEmphasis: "image" }));
  assert.ok(/<img[^>]*alt="The SynraPay dashboard"/i.test(withImage.html), "hero image with alt text");

  const withoutImage = render(baseDesign(), {}, {});
  assetRefs = [];
  assert.ok(!/<img/i.test(withoutImage.html), "no filler imagery without a real asset");
});

test("2e. brand colours drive the design and stay legible", async () => {
  rendererModule ??= await import("../lib/email/branded/renderer.ts");
  const { safeBrandColor, readableTextOn } = rendererModule;

  assert.equal(safeBrandColor("#1A73E8"), "#1a73e8");
  assert.equal(safeBrandColor("not-a-color"), null);
  assert.equal(safeBrandColor("#GGGGGG"), null);

  // White text on a dark brand colour; a dark text on a light one.
  assert.equal(readableTextOn("#1A73E8"), "#ffffff");
  const lightText = readableTextOn("#F4F1EC");
  assert.match(lightText, /^#[0-9a-f]{6}$/i, "returns a hex colour");
  // The light-on-light case must NOT return white.
  assert.notEqual(lightText.toLowerCase(), "#ffffff");

  const branded = render(baseDesign(), { primaryColor: "#7C3AED" });
  assert.ok(branded.html.toLowerCase().includes("#7c3aed"), "the brand colour is used");
});

test("2f. the unsubscribe link is present and real in both HTML and plain text", async () => {
  rendererModule ??= await import("../lib/email/branded/renderer.ts");
  const rendered = render(baseDesign());
  assert.ok(rendered.html.includes("https://app.voom.example/unsubscribe?token=tok123"), "real link in HTML");
  assert.ok(rendered.html.toLowerCase().includes("unsubscribe"), "an unsubscribe affordance in HTML");
  assert.ok(rendered.text.includes("https://app.voom.example/unsubscribe?token=tok123"), "real link in text");
  assert.ok(rendered.text.includes("You subscribed to SynraPay updates."), "the reason line");
});

test("2g. the footer carries the reply-to and a business line, never a Voom ops inbox", async () => {
  rendererModule ??= await import("../lib/email/branded/renderer.ts");
  const rendered = render(baseDesign());
  assert.ok(rendered.html.includes("support@synrapay.com"), "reply-to shown in the footer");
  assert.ok(rendered.html.includes("SynraPay Ltd · 12 Marina Square, Dubai"), "real footer line");
  assert.ok(!rendered.html.toLowerCase().includes("voom ops"), "no Voom ops identity");
});

// ─── 3. MARA design: validated structure only ─────────────────────────────────

test("3a. a valid design spec is accepted and rendered", async () => {
  const { validateEmailDesign, acceptProposedDesign } = await import("../lib/email/branded/design.ts");
  const valid = {
    layout: "announcement",
    subject: "Now live",
    preheader: "Something new",
    headline: "Now live",
    sections: [{ kind: "text", text: "The feature is here." }],
    cta: { label: "See it", url: "https://synrapay.com/feature" },
    heroAssetId: null,
    tone: "Excited",
    visualEmphasis: "brand",
  };
  const check = validateEmailDesign(valid, { allowedUrls: ["https://synrapay.com/feature"] });
  assert.equal(check.ok, true, JSON.stringify(check));

  // A URL that is not explicitly allowed (even a subpath of the site) is refused.
  const notAllowed = validateEmailDesign(valid, { allowedUrls: ["https://synrapay.com"] });
  assert.equal(notAllowed.ok, false, JSON.stringify(notAllowed));

  const accepted = acceptProposedDesign(valid, {
    subject: "Now live",
    body: "Body copy",
    cta: "See it",
    ctaUrl: "https://synrapay.com/feature",
    allowedUrls: ["https://synrapay.com", "https://synrapay.com/feature"],
    assets: [],
    brandName: "SynraPay",
  });
  assert.ok(accepted, "the validated proposal is used");
  assert.equal(accepted.layout, "announcement");
});

test("3b. arbitrary HTML anywhere in the spec is rejected", async () => {
  const { validateEmailDesign } = await import("../lib/email/branded/design.ts");
  const htmlSection = {
    layout: "welcome",
    subject: "x",
    preheader: "",
    headline: "x",
    sections: [{ kind: "html", text: "<script>alert(1)</script>" }],
    cta: { label: "Go", url: null },
    heroAssetId: null,
    tone: "",
    visualEmphasis: "brand",
  };
  const result = validateEmailDesign(htmlSection, { allowedUrls: [] });
  assert.equal(result.ok, false);
});

test("3c. an invented CTA URL is refused; the renderer falls back safely", async () => {
  const { acceptProposedDesign, compileEmailDesign } = await import("../lib/email/branded/design.ts");
  const proposed = {
    layout: "welcome",
    subject: "x",
    preheader: "",
    headline: "x",
    sections: [{ kind: "text", text: "Copy" }],
    cta: { label: "Learn more", url: "https://not-allowed.example/phish" },
    heroAssetId: null,
    tone: "",
    visualEmphasis: "brand",
  };
  const input = {
    subject: "x",
    body: "Copy",
    cta: "Learn more",
    ctaUrl: null,
    allowedUrls: ["https://synrapay.com"],
    assets: [],
    brandName: "SynraPay",
  };
  const accepted = acceptProposedDesign(proposed, input);
  assert.equal(accepted, null, "the proposal with an invented URL is refused");

  const compiled = compileEmailDesign(input).design;
  assert.equal(compiled.cta.url, null, "the fallback compiler never invents a URL");
});

test("3d. a CTA URL on the allowlist is accepted", async () => {
  const { validateEmailDesign } = await import("../lib/email/branded/design.ts");
  const result = validateEmailDesign(
    {
      layout: "minimal",
      subject: "x",
      preheader: "",
      headline: "x",
      sections: [{ kind: "text", text: "Copy" }],
      cta: { label: "Open", url: "https://synrapay.com" },
      heroAssetId: null,
      tone: "",
      visualEmphasis: "brand",
    },
    { allowedUrls: ["https://synrapay.com"] },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
});

test("3e. a design referencing an unknown asset is refused", async () => {
  const { validateEmailDesign } = await import("../lib/email/branded/design.ts");
  const result = validateEmailDesign(
    {
      layout: "product",
      subject: "x",
      preheader: "",
      headline: "x",
      sections: [{ kind: "text", text: "Copy" }],
      cta: { label: "Open", url: null },
      heroAssetId: "asset-does-not-exist",
      tone: "",
      visualEmphasis: "image",
    },
    { allowedUrls: [], allowedAssetIds: ["asset-1"] },
  );
  assert.equal(result.ok, false);
});

test("3f. layout selection is bounded to the validated families", async () => {
  const { selectEmailLayout, EMAIL_LAYOUTS } = await import("../lib/email/branded/design.ts");
  assert.ok(EMAIL_LAYOUTS.length >= 4 && EMAIL_LAYOUTS.length <= 6, "4–6 families, not 50 templates");
  for (const flowType of ["welcome", "re_engagement", null]) {
    const selection = selectEmailLayout({ flowType, campaignObjective: null, campaignName: null, hasImage: false });
    assert.ok(EMAIL_LAYOUTS.includes(selection.layout), `${flowType} → ${selection.layout}`);
  }
});

// ─── 4. Personalization ───────────────────────────────────────────────────────

test("4. tokens: replaced, fell back, scrubbed", async () => {
  const { applyPersonalization, findUnresolvedTokens, scrubUnresolvedTokens } = await import("../lib/email/branded/personalize.ts");

  assert.equal(applyPersonalization("Hi {firstName},", { firstName: "Ada" }), "Hi Ada,");
  assert.equal(applyPersonalization("Hi {firstName},", { firstName: null }), "Hi there,");
  assert.equal(applyPersonalization("{businessName} is here", { businessName: "SynraPay" }), "SynraPay is here");

  assert.deepEqual(findUnresolvedTokens("Hi {firstName}, welcome to {unknownToken}"), ["{firstName}", "{unknownToken}"]);
  assert.equal(findUnresolvedTokens("nothing to see here").length, 0);

  // Scrubbing never leaves a raw token behind.
  const scrubbed = scrubUnresolvedTokens("Hi {firstName}, see {weirdToken}");
  assert.ok(!scrubbed.includes("{firstName}") && !scrubbed.includes("{weirdToken}"));
});

// ─── 5. Unsubscribe: real, signed, tamper-proof ──────────────────────────────

test("5a. a minted token verifies and processes an idempotent unsubscribe", async () => {
  const { mintUnsubscribeToken, verifyUnsubscribeToken, processEmailUnsubscribe } = await import("../lib/email/branded/unsubscribe.ts");
  const admin = createAdmin(businessTables);

  const token = mintUnsubscribeToken(OWNER, "Ada@Example.com");
  assert.equal(mintUnsubscribeToken(OWNER, "ada@example.com"), token, "deterministic per owner + address (case-insensitive)");

  const check = verifyUnsubscribeToken(token);
  assert.equal(check.ok, true);
  assert.equal(check.email, "ada@example.com");

  const first = await processEmailUnsubscribe(admin, { ownerId: OWNER, email: "ada@example.com" });
  assert.equal(first.ok, true);
  assert.equal(first.reason, "unsubscribed");
  assert.equal(first.businessName, "SynraPay");

  const second = await processEmailUnsubscribe(admin, { ownerId: OWNER, email: "ada@example.com" });
  assert.equal(second.ok, true);
  assert.equal(second.reason, "already_unsubscribed");
  assert.equal((admin.rpcCalls).filter((call) => call.name === "record_email_unsubscribe").length, 2);
});

test("5b. tampered, forged and malformed tokens are all refused", async () => {
  const { mintUnsubscribeToken, verifyUnsubscribeToken } = await import("../lib/email/branded/unsubscribe.ts");

  const token = mintUnsubscribeToken(OWNER, "ada@example.com");
  const [payloadPart, signaturePart] = token.split(".");

  // Flip one payload character (re-encode base64url of a tampered payload).
  const tamperedPayload = Buffer.from(payloadPart, "base64url").toString("utf8").replace(OWNER, OTHER);
  const tampered = `${Buffer.from(tamperedPayload).toString("base64url")}.${signaturePart}`;
  assert.equal(verifyUnsubscribeToken(tampered).ok, false, "payload tampering is caught");

  // Flip a signature character.
  const flippedSig = signaturePart.slice(0, -1) + (signaturePart.endsWith("A") ? "B" : "A");
  assert.equal(verifyUnsubscribeToken(`${payloadPart}.${flippedSig}`).ok, false, "signature tampering is caught");

  // Another owner's token never verifies for this owner's email.
  const otherToken = mintUnsubscribeToken(OTHER, "ada@example.com");
  const otherCheck = verifyUnsubscribeToken(otherToken);
  assert.ok(!otherCheck.ok || otherCheck.ownerId !== OWNER, "owner scope is enforced");

  assert.equal(verifyUnsubscribeToken("garbage").reason, "malformed");
  assert.equal(verifyUnsubscribeToken("").reason, "malformed");
});

test("5c. with no secret configured, minting is refused (never a fake link)", async () => {
  const saved = process.env.EMAIL_UNSUBSCRIBE_SECRET;
  const savedSupabase = process.env.SUPABASE_SECRET_KEY;
  delete process.env.EMAIL_UNSUBSCRIBE_SECRET;
  delete process.env.SUPABASE_SECRET_KEY;
  try {
    const { isUnsubscribeMintingConfigured, verifyUnsubscribeToken } = await import("../lib/email/branded/unsubscribe.ts");
    assert.equal(isUnsubscribeMintingConfigured(), false);
    assert.equal(verifyUnsubscribeToken("anything.at.all").reason, "not_configured");
  } finally {
    if (saved === undefined) delete process.env.EMAIL_UNSUBSCRIBE_SECRET;
    else process.env.EMAIL_UNSUBSCRIBE_SECRET = saved;
    if (savedSupabase === undefined) delete process.env.SUPABASE_SECRET_KEY;
    else process.env.SUPABASE_SECRET_KEY = savedSupabase;
  }
});

test("5d. SUPABASE_SECRET_KEY is never a fallback signing key", async () => {
  const saved = process.env.EMAIL_UNSUBSCRIBE_SECRET;
  const savedSupabase = process.env.SUPABASE_SECRET_KEY;
  delete process.env.EMAIL_UNSUBSCRIBE_SECRET;
  // The Supabase secret must not stand in for EMAIL_UNSUBSCRIBE_SECRET even
  // when it is the only secret present in the environment.
  process.env.SUPABASE_SECRET_KEY = "decoy_supabase_secret_never_a_signing_key";
  try {
    const { isUnsubscribeMintingConfigured, verifyUnsubscribeToken } = await import("../lib/email/branded/unsubscribe.ts");
    assert.equal(isUnsubscribeMintingConfigured(), false, "no fallback to SUPABASE_SECRET_KEY");
    assert.equal(verifyUnsubscribeToken("anything.at.all").reason, "not_configured");
  } finally {
    if (saved === undefined) delete process.env.EMAIL_UNSUBSCRIBE_SECRET;
    else process.env.EMAIL_UNSUBSCRIBE_SECRET = saved;
    if (savedSupabase === undefined) delete process.env.SUPABASE_SECRET_KEY;
    else process.env.SUPABASE_SECRET_KEY = savedSupabase;
  }
});

test("5e. no other credential substitutes for EMAIL_UNSUBSCRIBE_SECRET", async () => {
  const saved = process.env.EMAIL_UNSUBSCRIBE_SECRET;
  const savedOthers = {
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
    CRON_SECRET: process.env.CRON_SECRET,
    EMAIL_PROVIDER_API_KEY: process.env.EMAIL_PROVIDER_API_KEY,
    EMAIL_WEBHOOK_SECRET: process.env.EMAIL_WEBHOOK_SECRET,
    AI_API_KEY: process.env.AI_API_KEY,
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  };
  delete process.env.EMAIL_UNSUBSCRIBE_SECRET;
  // Every plausible look-alike credential is present — none of them may be
  // borrowed for unsubscribe signing/verification (no derived or
  // runtime-generated key either).
  process.env.SUPABASE_SECRET_KEY = "decoy_supabase_secret";
  process.env.CRON_SECRET = "decoy_cron_secret";
  process.env.EMAIL_PROVIDER_API_KEY = "re_decoy_provider_key";
  process.env.EMAIL_WEBHOOK_SECRET = "whsec_decoy";
  process.env.AI_API_KEY = "sk-decoy";
  process.env.ENCRYPTION_KEY = "decoy_encryption_key";
  try {
    const { isUnsubscribeMintingConfigured, verifyUnsubscribeToken } = await import("../lib/email/branded/unsubscribe.ts");
    assert.equal(isUnsubscribeMintingConfigured(), false, "EMAIL_UNSUBSCRIBE_SECRET is exclusive");
    assert.equal(verifyUnsubscribeToken("anything.at.all").reason, "not_configured");
  } finally {
    if (saved === undefined) delete process.env.EMAIL_UNSUBSCRIBE_SECRET;
    else process.env.EMAIL_UNSUBSCRIBE_SECRET = saved;
    for (const [name, value] of Object.entries(savedOthers)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

// ─── 6. Assets: owner-scoped, verified bytes, rollback on failure ────────────

test("6a. publishing verifies real image bytes and registers the row", async () => {
  const { publishEmailAsset } = await import("../lib/email/branded/assets.ts");
  const admin = createAdmin(businessTables);
  const storage = createStorage();

  // A real 1x1 JPEG (magic bytes verified server-side).
  const jpeg = Buffer.from(
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////",
    "base64",
  );
  const asset = await publishEmailAsset(admin, storage, {
    ownerId: OWNER,
    bytes: new Uint8Array(jpeg),
    altText: "Logo",
    sourceKind: "uploaded",
  });

  assert.equal(asset.status, "ready");
  assert.ok(asset.public_url.includes(`${OWNER}/`), "owner-scoped object path");
  assert.equal(storage.objects.size, 1);
  assert.ok(admin.rpcCalls.some((call) => call.name === "create_email_asset"));
});

test("6b. non-image bytes are refused before anything is stored", async () => {
  const { publishEmailAsset, EmailAssetError } = await import("../lib/email/branded/assets.ts");
  const admin = createAdmin(businessTables);
  const storage = createStorage();

  await assert.rejects(
    publishEmailAsset(admin, storage, {
      ownerId: OWNER,
      bytes: new TextEncoder().encode("definitely not an image"),
      altText: "x",
      sourceKind: "uploaded",
    }),
    (error) => error instanceof EmailAssetError && error.code === "invalid_image",
  );
  assert.equal(storage.objects.size, 0, "nothing stored");
  assert.equal(admin.rpcCalls.length, 0, "no row created");
});

test("6c. when the row fails to persist, the object is rolled back", async () => {
  const { publishEmailAsset, EmailAssetError } = await import("../lib/email/branded/assets.ts");
  const admin = createAdmin(businessTables);
  const storage = createStorage();

  const failingAdmin = {
    ...admin,
    rpc() {
      return {
        data: null,
        error: { message: "rpc_denied" },
        single: async () => ({ data: null, error: { message: "rpc_denied" } }),
      };
    },
  };

  const jpeg = Buffer.from(
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////",
    "base64",
  );
  await assert.rejects(
    publishEmailAsset(failingAdmin, storage, {
      ownerId: OWNER,
      bytes: new Uint8Array(jpeg),
      altText: "Logo",
      sourceKind: "uploaded",
    }),
    (error) => error instanceof EmailAssetError && error.code === "persist_failed",
  );
  assert.equal(storage.objects.size, 0, "the orphan object was deleted");
  assert.equal(storage.deleted.length, 1);
});

test("6d. only the owner's own draft assets can be copied into the public bucket", async () => {
  const { publishDraftAssetAsEmailAsset, EmailAssetError } = await import("../lib/email/branded/assets.ts");
  const admin = createAdmin({
    ...businessTables,
    post_draft_assets: [
      { id: "draft-1", owner_user_id: OTHER, draft_id: "d1", storage_path: "other/x.jpg", mime_type: "image/jpeg" },
    ],
  });
  const storage = createStorage();

  await assert.rejects(
    publishDraftAssetAsEmailAsset(admin, storage, { ownerId: OWNER, draftId: "draft-1", altText: "stolen" }),
    (error) => error instanceof EmailAssetError,
  );
  assert.equal(storage.objects.size, 0);
});

// ─── 7. The shared send path: one pipeline, honest outcomes ──────────────────

test("7a. prepare → dispatch: accepted (never 'delivered'), idempotency key on the wire", async () => {
  const { prepareBrandedSend, dispatchBrandedEmail } = await import("../lib/email/branded/dispatch.ts");
  const admin = createAdmin(businessTables);
  const provider = createProvider();

  const prepared = await prepareBrandedSend(
    {
      admin,
      ownerId: OWNER,
      to: "ada@example.com",
      idempotencyKey: "flow-attempt-1",
      subject: "Welcome to SynraPay",
      body: "Hi {firstName},\n\nThanks for subscribing.",
      cta: "",
      ctaUrl: null,
      flowType: "welcome",
      firstName: "Ada",
    },
    { client: provider.client },
  );

  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.equal(prepared.payload.from, `${ENV.EMAIL_FROM_NAME} <${ENV.EMAIL_FROM_ADDRESS}>`);
  assert.match(prepared.payload.text, /^Hi Ada,/);
  assert.ok(!prepared.payload.unsubscribeUrl.includes("ada@example.com"), "the raw address is never exposed in the link");
  assert.ok(prepared.payload.unsubscribeUrl.includes("unsubscribe"));

  const response = await dispatchBrandedEmail(prepared.payload, { client: provider.client });
  assert.equal(response.ok, true);
  assert.equal(response.providerMessageId, "msg_1");
  assert.equal(response.providerStatus, "accepted", "the provider outcome is 'accepted', full stop");
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].path, "emails");
  assert.deepEqual(provider.calls[0].body.to, ["ada@example.com"]);
  assert.equal(provider.calls[0].headers["Idempotency-Key"], "flow-attempt-1");
  assert.ok(provider.calls[0].body.html, "HTML is sent");
  assert.ok(provider.calls[0].body.text, "plain text is sent");
});

test("7b. the quality guard fails closed: a bad email is never dispatched", async () => {
  const { prepareBrandedSend } = await import("../lib/email/branded/dispatch.ts");
  const admin = createAdmin(businessTables);
  const provider = createProvider();

  // Whitespace-only subject → guard failure, terminal, provider untouched.
  const prepared = await prepareBrandedSend(
    {
      admin,
      ownerId: OWNER,
      to: "ada@example.com",
      idempotencyKey: "k1",
      subject: "   ",
      body: "Hi {firstName},\n\nSee {mysteryToken} for details.",
      cta: "",
      ctaUrl: null,
      flowType: "welcome",
      firstName: "Ada",
    },
    { client: provider.client },
  );

  assert.equal(prepared.ok, false);
  assert.equal(prepared.terminal, true, "a guard failure will not change on retry");
  const codes = (prepared.qualityFailures ?? []).map((failure) => failure.code);
  assert.ok(codes.includes("subject_empty"), JSON.stringify(codes));

  // Nothing reached the provider.
  assert.equal(provider.calls.length, 0);
});

test("7c-0. the guard catches unresolved tokens and a missing unsubscribe directly", async () => {
  const { runEmailQualityChecks } = await import("../lib/email/branded/quality.ts");
  const baseInput = {
    sender: { fromName: "SynraPay", fromAddress: "hello@synrapay.com", replyTo: null },
    subject: "Subject",
    design: {
      layout: "welcome",
      subject: "Subject",
      preheader: "",
      headline: "H",
      sections: [{ kind: "text", text: "Body" }],
      cta: { label: "Go", url: null },
      heroAssetId: null,
      tone: "",
      visualEmphasis: "brand",
    },
    html: '<!DOCTYPE html><html><body><a href="https://x.example/u?token=t">Unsubscribe</a>{leakedToken}</body></html>',
    text: "Body\nUnsubscribe: https://x.example/u?token=t\n{leakedToken}",
    unsubscribeUrl: "https://x.example/u?token=t",
    referencedAssetIds: [],
    resolvedAssetIds: [],
  };

  const withTokens = runEmailQualityChecks(baseInput);
  assert.ok(withTokens.failures.some((failure) => failure.code === "unresolved_tokens"), JSON.stringify(withTokens.failures));

  const withoutUnsubscribe = runEmailQualityChecks({
    ...baseInput,
    html: "<!DOCTYPE html><html><body>No link here</body></html>",
    text: "Body",
    unsubscribeUrl: null,
  });
  assert.ok(withoutUnsubscribe.failures.some((failure) => failure.code === "unsubscribe_missing"), JSON.stringify(withoutUnsubscribe.failures));

  const badCta = runEmailQualityChecks({
    ...baseInput,
    design: { ...baseInput.design, cta: { label: "Go", url: "not-a-url" } },
  });
  assert.ok(badCta.failures.some((failure) => failure.code === "cta_url_invalid"), JSON.stringify(badCta.failures));
});

test("7c. campaign and flow sends share the same renderer + resolver", async () => {
  const { prepareBrandedSend } = await import("../lib/email/branded/dispatch.ts");
  const admin = createAdmin(businessTables);
  const provider = createProvider();
  const deps = { client: provider.client };
  const content = {
    admin,
    ownerId: OWNER,
    to: "ada@example.com",
    subject: "The same subject",
    body: "Hi {firstName},\n\nSame body copy.",
    cta: "",
    ctaUrl: null,
    firstName: "Ada",
  };

  // The same content through the two stack shapes: byte-identical HTML,
  // same sender — one deterministic pipeline, no per-stack renderer fork.
  // (Identical layout inputs on purpose: only the idempotency key differs.)
  const flow = await prepareBrandedSend({ ...content, idempotencyKey: "flow-1" }, deps);
  const campaign = await prepareBrandedSend({ ...content, idempotencyKey: "campaign-1" }, deps);

  assert.equal(flow.ok, true, JSON.stringify(flow));
  assert.equal(campaign.ok, true, JSON.stringify(campaign));
  assert.equal(flow.payload.html, campaign.payload.html, "the same deterministic renderer produced both");
  assert.equal(flow.payload.text, campaign.payload.text, "the same plain text, both stacks");
  assert.equal(flow.payload.from, campaign.payload.from, "the same sender resolver resolved both");
  assert.equal(provider.calls.length, 0, "preparation alone never sends");

  // The campaign's objective still steers layout selection deterministically.
  const launch = await prepareBrandedSend(
    { ...content, idempotencyKey: "campaign-2", campaignObjective: "Announcing our launch" },
    deps,
  );
  assert.equal(launch.ok, true);
  assert.equal(launch.payload.layoutReason, "objective mentions announcement territory");
  assert.notEqual(launch.payload.html, campaign.payload.html, "a different objective produces a different layout");
});

test("7d. the flow send adapter funnels through the branded engine", async () => {
  const sendModule = await import("../lib/email-flows/send.ts");
  assert.equal(typeof sendModule.sendFlowEmail, "function");
  const engineSource = await (await import("node:fs/promises")).readFile(
    new URL("../lib/email-flows/engine.ts", import.meta.url),
    "utf8",
  );
  assert.match(engineSource, /sendFlowEmail/, "the engine sends through the shared adapter");
  assert.doesNotMatch(engineSource, /seedream|seedance|openrouter|media-credit/i, "no media path in the engine");
});

test("7e. the campaign send helper uses the branded engine, not a second sender", async () => {
  const source = await (await import("node:fs/promises")).readFile(
    new URL("../lib/voom/campaign-delivery.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /prepareBrandedSend/, "campaigns prepare through the shared engine");
  assert.match(source, /dispatchBrandedEmail/, "campaigns dispatch through the shared engine");
  assert.doesNotMatch(source, /createResendClient\(\)\.post|from: `\$\{client\.config/, "no hardcoded global-identity send remains");
});

// ─── 8. Zero external calls ──────────────────────────────────────────────────

test("8. nothing in this suite touched the network", async () => {
  assert.equal(fetchCalls, 0, "no fetch was ever made");
});
