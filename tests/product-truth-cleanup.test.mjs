/**
 * Product Truth Cleanup — regression guards.
 *
 * Voom's active V1 channels are exactly Instagram, TikTok, YouTube and Email.
 * These tests pin that the product tells the truth about them everywhere the
 * cleanup touched:
 *
 *   1. Onboarding offers only the four genuinely supported channels, derived
 *      from the ONE canonical vocabulary (lib/social/channels.ts), while
 *      historical stored `preferred_channels` values round-trip untouched.
 *   2. The onboarding "Connect" step no longer fakes an email connection or
 *      claims other channels have no real authorization flow.
 *   3. No UI text claims YouTube publishing is unimplemented / not connected.
 *   4. The wizard's website reaches its only real consumer (the email brand
 *      profile, `upsert_email_brand`) best-effort; brand colour — which had no
 *      consumer at all — is gone rather than pretending to drive previews.
 *   5. MARA's tool facts read the REAL plan and the REAL connection state of
 *      all three social providers instead of hardcoded legacy values.
 *
 * The onboarding save runs the REAL server action (lib/voom/mutations.ts)
 * against a fake Supabase client and a fake admin client, so the website
 * write is verified as behaviour, not as a string match.
 */
import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/cache") {
      return { url: `data:text/javascript,${encodeURIComponent("export function revalidatePath() {}")}`, shortCircuit: true };
    }
    if (specifier === "next/headers") {
      return {
        url: `data:text/javascript,${encodeURIComponent("export async function cookies() { return { getAll: () => [], set: () => {} }; }")}`,
        shortCircuit: true,
      };
    }
    if (specifier === "@/utils/supabase/server") {
      return {
        url: `data:text/javascript,${encodeURIComponent("export async function createClient() { return globalThis.__VOOM_FAKE_SUPABASE__; }")}`,
        shortCircuit: true,
      };
    }
    if (specifier === "@/utils/supabase/admin") {
      return {
        url: `data:text/javascript,${encodeURIComponent("export function createAdminClient() { return globalThis.__VOOM_FAKE_ADMIN__(); }")}`,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

const { saveBrandSettings, saveOnboarding } = await import("../lib/voom/mutations.ts");
const { brandFromBusiness, emptyBrand } = await import("../lib/voom/brand-state.ts");
const { normalizeWebsiteUrl, WEBSITE_NOT_SAVED_NOTICE } = await import("../lib/voom/website.ts");
const { Q_CHANNELS } = await import("../lib/voom/onboardingData.ts");
const { SOCIAL_CHANNELS, SOCIAL_CHANNEL_LABELS } = await import("../lib/social/channels.ts");

const HISTORICAL_CHANNELS = ["Instagram", "Facebook", "WhatsApp", "Google", "Paid ads"];

function businessRow(overrides = {}) {
  return {
    id: "biz-1",
    owner_user_id: "owner-1",
    brand_name: "Bean & Co.",
    brand_description: "We roast our own beans.",
    industry: "Restaurant / Café",
    target_customer: ["Local residents nearby"],
    main_goal: "More walk-in customers",
    brand_personality: ["Friendly"],
    preferred_channels: HISTORICAL_CHANNELS,
    monthly_ad_budget: "AED 1,000 – 3,000",
    content_frequency: "2-3x_week",
    automation_level: "assisted",
    publishing_permission: "Yes — always ask first",
    plan: "free",
    onboarding_completed: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function onboardingPayload(overrides = {}) {
  return {
    displayName: "Alex",
    brandName: "Bean & Co.",
    brandDescription: "We roast our own beans.",
    industry: "Restaurant / Café",
    targetCustomer: ["Local residents nearby"],
    mainGoal: "More walk-in customers",
    brandPersonality: ["Friendly"],
    preferredChannels: ["Instagram", "Email"],
    monthlyAdBudget: "AED 0 — organic only",
    contentFrequency: "2-3x_week",
    automationLevel: "assisted",
    publishingPermission: "Yes — always ask first",
    ...overrides,
  };
}

/** Fake user-scoped client (businesses/profiles upserts) + fake admin RPC. */
function makeFakes({ rpcError = null, adminThrows = false } = {}) {
  const calls = { businessesUpsert: [], rpc: [] };
  globalThis.__VOOM_FAKE_SUPABASE__ = {
    from(table) {
      return {
        upsert: async (payload) => {
          if (table === "businesses") calls.businessesUpsert.push(payload);
          return { error: null, data: { id: "row-1" } };
        },
        update: async () => ({ error: null, data: [] }),
      };
    },
    auth: {
      getClaims: async () => ({ data: { claims: { sub: "owner-1", email: "owner@example.com" } }, error: null }),
    },
  };
  globalThis.__VOOM_FAKE_ADMIN__ = () => {
    if (adminThrows) throw new Error("supabase_admin_not_configured");
    return {
      rpc: async (name, args) => {
        calls.rpc.push({ name, args });
        return { data: null, error: rpcError };
      },
    };
  };
  return calls;
}

// ── 1. Channel vocabulary ──────────────────────────────────────────────────

test("onboarding offers exactly the four supported V1 channels, from the canonical vocabulary", () => {
  assert.deepEqual(Q_CHANNELS, ["Instagram", "TikTok", "YouTube", "Email"]);
  assert.deepEqual(Q_CHANNELS, SOCIAL_CHANNELS.map((channel) => SOCIAL_CHANNEL_LABELS[channel]));
  for (const retired of ["Facebook", "WhatsApp", "Google", "Paid ads", "SMS"]) {
    assert.equal(Q_CHANNELS.includes(retired), false, `${retired} must not be offered`);
  }
});

test("historical unsupported preferred_channels round-trip verbatim through load and save", async () => {
  const row = businessRow();
  const brand = brandFromBusiness(row);
  assert.deepEqual(brand.channels, HISTORICAL_CHANNELS);

  const calls = makeFakes();
  const result = await saveBrandSettings({
    displayName: "Alex",
    brandName: brand.name,
    brandDescription: brand.desc,
    industry: brand.industry,
    targetCustomer: brand.audience,
    mainGoal: brand.goals[0] ?? "",
    brandPersonality: brand.tone,
    preferredChannels: brand.channels,
    monthlyAdBudget: brand.budget,
    contentFrequency: brand.freq,
    automationLevel: brand.auto,
    publishingPermission: brand.permission,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.businessesUpsert[0].preferred_channels, HISTORICAL_CHANNELS);
});

test("nothing in the app rewrites or filters stored preferred_channels against the new list", async () => {
  const [mutations, brandState, store] = await Promise.all([
    read("lib/voom/mutations.ts"),
    read("lib/voom/brand-state.ts"),
    read("lib/voom/store.tsx"),
  ]);
  for (const source of [mutations, brandState, store]) {
    assert.doesNotMatch(source, /Q_CHANNELS/);
  }
  assert.match(brandState, /channels: business\.preferred_channels/);
});

// ── 2. Onboarding "Connect" step tells the truth ───────────────────────────

test("onboarding wizard no longer fakes an email connection or misdescribes the other channels", async () => {
  const wizard = await read("components/voom/onboarding/OnboardingWizard.tsx");
  assert.doesNotMatch(wizard, /not available yet/i);
  assert.doesNotMatch(wizard, /integration is not available/i);
  assert.doesNotMatch(wizard, /only Instagram/i);
  assert.doesNotMatch(wizard, /real authorization flow.*Instagram/i);
  // The wizard cannot connect anything (the workspace does not exist until
  // Finish setup), so it must not offer an in-wizard Connect button.
  assert.doesNotMatch(wizard, /onConnect/);
  // All four channels are represented, and email is described as what it is.
  for (const name of ["Instagram", "TikTok", "YouTube", "Email"]) assert.match(wizard, new RegExp(`name: "${name}"|<b className="text-\\[14px\\]">${name}</b>`));
  assert.match(wizard, /There is no account to connect/);
  assert.match(wizard, /Settings → Email identity/);
  assert.match(wizard, /nothing is published anywhere until you approve it/);
  // Connection state comes from the real status endpoints, never assumed.
  for (const channel of ["instagram", "tiktok", "youtube"]) assert.match(wizard, new RegExp(`/api/integrations/${channel}/status`));
});

// ── 3. No stale "YouTube publishing is not implemented" claims ─────────────

test("no UI or domain comment still claims YouTube or TikTok publishing is unimplemented", async () => {
  const files = [
    "components/voom/modals/CreateContentModal.tsx",
    "components/voom/modals/BuildCampaignModal.tsx",
    "components/voom/modals/AutomatedCampaignModal.tsx",
    "components/voom/onboarding/OnboardingWizard.tsx",
    "lib/campaign/types.ts",
    "lib/post/core.ts",
    "lib/social/connections.ts",
    "lib/mara/tools.ts",
    "lib/mara/prompt.ts",
    "app/app/(shell)/today/page.tsx",
  ];
  const stale = [
    /YouTube publishing is not connected/i,
    /Publishing is not connected yet/i,
    /publishing there starts when their connections ship/i,
    /connections do not exist yet/i,
    /cannot publish until the real provider integrations exist/i,
    /provider connection that does not exist yet/i,
    /when the real \$\{label\} integration ships/,
    /publishing those channels is not connected yet/i,
    /channels are Instagram and email\b/i,
  ];
  for (const file of files) {
    const source = await read(file);
    for (const pattern of stale) assert.doesNotMatch(source, pattern, `${file} still contains ${pattern}`);
  }
  // The truthful limitations stay: Published only after the provider confirms,
  // and the flow never fakes a publication.
  const create = await read("components/voom/modals/CreateContentModal.tsx");
  assert.match(create, /Nothing is published to any platform/);
  assert.match(create, /only after YouTube confirms/);
  assert.match(create, /never fakes a publication/);
});

// ── 4. Website persists through its real consumer; colour is gone ──────────

test("normalizeWebsiteUrl accepts plausible sites, adds https, and drops junk instead of failing", () => {
  assert.equal(normalizeWebsiteUrl("yourbusiness.ae"), "https://yourbusiness.ae");
  assert.equal(normalizeWebsiteUrl("  www.example.com/menu  "), "https://www.example.com/menu");
  assert.equal(normalizeWebsiteUrl("http://example.com"), "http://example.com");
  assert.equal(normalizeWebsiteUrl("https://Example.COM/path?x=1"), "https://Example.COM/path?x=1");
  assert.equal(normalizeWebsiteUrl(""), null);
  assert.equal(normalizeWebsiteUrl("   "), null);
  assert.equal(normalizeWebsiteUrl(undefined), null);
  assert.equal(normalizeWebsiteUrl(null), null);
  assert.equal(normalizeWebsiteUrl("not a url"), null);
  assert.equal(normalizeWebsiteUrl("beanandco"), null);
  assert.equal(normalizeWebsiteUrl("ftp://example.com"), null);
  assert.equal(normalizeWebsiteUrl("javascript:alert(1)"), null);
  assert.equal(normalizeWebsiteUrl(`https://${"a".repeat(500)}.com`), null);
  // Every accepted value satisfies the upsert_email_brand RPC's own check.
  for (const value of ["yourbusiness.ae", "http://example.com", "www.example.com/menu"]) {
    assert.match(normalizeWebsiteUrl(value), /^https?:\/\/\S+$/);
  }
});

test("onboarding without a website never touches the email brand profile", async () => {
  const calls = makeFakes();
  const result = await saveOnboarding(onboardingPayload());
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.businessesUpsert.length, 1);
  assert.equal(calls.rpc.length, 0);

  const skipped = makeFakes();
  assert.deepEqual(await saveOnboarding(onboardingPayload({ website: "" })), { ok: true });
  assert.equal(skipped.rpc.length, 0);
});

test("onboarding with a website stores it ONLY through upsert_email_brand, with only the website key", async () => {
  const calls = makeFakes();
  const result = await saveOnboarding(onboardingPayload({ website: "beanandco.ae" }));
  assert.deepEqual(result, { ok: true });

  // Not on businesses — no invented column.
  assert.equal("website" in calls.businessesUpsert[0], false);
  assert.equal(calls.businessesUpsert[0].onboarding_completed, true);

  // Exactly one RPC, the existing authoritative writer, owner-scoped, and a
  // payload that cannot clobber logo/colours/footer (the RPC coalesces
  // missing keys).
  assert.equal(calls.rpc.length, 1);
  assert.equal(calls.rpc[0].name, "upsert_email_brand");
  assert.equal(calls.rpc[0].args.p_owner_user_id, "owner-1");
  assert.deepEqual(calls.rpc[0].args.p_payload, { website: "https://beanandco.ae" });
});

test("a failed website write can never fail onboarding — it surfaces as a notice", async () => {
  const rpcFailed = makeFakes({ rpcError: { message: "website must be an http(s) URL" } });
  const result = await saveOnboarding(onboardingPayload({ website: "beanandco.ae" }));
  assert.equal(result.ok, true);
  assert.equal(result.notice, WEBSITE_NOT_SAVED_NOTICE);
  assert.equal(rpcFailed.businessesUpsert[0].onboarding_completed, true);

  const noAdmin = makeFakes({ adminThrows: true });
  const fallback = await saveOnboarding(onboardingPayload({ website: "https://beanandco.ae" }));
  assert.equal(fallback.ok, true);
  assert.equal(fallback.notice, WEBSITE_NOT_SAVED_NOTICE);
  assert.equal(noAdmin.businessesUpsert.length, 1);
  assert.equal(noAdmin.rpc.length, 0);
});

test("the onboarding save runs after the business row exists (the RPC requires it)", async () => {
  const mutations = await read("lib/voom/mutations.ts");
  const businessesIndex = mutations.indexOf('from("businesses").upsert');
  const websiteIndex = mutations.indexOf("saveOnboardingWebsite(user.id, input.website)");
  assert.ok(businessesIndex > 0 && websiteIndex > businessesIndex);
  assert.match(mutations, /rpc\("upsert_email_brand"/);
  assert.match(mutations, /p_payload: \{ website \}/);
});

test("brand colour has no consumer and is gone; the website field says only what is true", async () => {
  const [wizard, data, types, brandState, store] = await Promise.all([
    read("components/voom/onboarding/OnboardingWizard.tsx"),
    read("lib/voom/onboardingData.ts"),
    read("lib/voom/types.ts"),
    read("lib/voom/brand-state.ts"),
    read("lib/voom/store.tsx"),
  ]);
  assert.doesNotMatch(data, /OB_COLORS/);
  assert.doesNotMatch(wizard, /OB_COLORS|Brand colour|Used across your previews|setOnboardField\("color"/);
  assert.doesNotMatch(types, /\bcolor: string/);
  assert.doesNotMatch(brandState, /\bcolor:/);
  assert.doesNotMatch(store, /\bcolor:/);
  assert.equal("color" in emptyBrand(), false);
  assert.equal("color" in brandFromBusiness(businessRow()), false);

  assert.match(wizard, /Website <span className="text-text-3">\(optional\)<\/span>/);
  assert.match(wizard, /marketing emails as the website link and default button destination/);
  assert.match(store, /website: skipped \? "" : o\.site/);
  assert.match(store, /if \(result\.notice\) toast\(result\.notice, "info"\)/);
});

// ── 5. MARA tool facts are real ────────────────────────────────────────────

test("MARA tools read the real plan and the real TikTok/YouTube connection state", async () => {
  const tools = await read("lib/mara/tools.ts");
  assert.doesNotMatch(tools, /plan: "free"/);
  assert.doesNotMatch(tools, /maraMessagesPerMinute/);
  assert.doesNotMatch(tools, /email: false/);
  assert.doesNotMatch(tools, /confirmed execution flow is implemented/);
  assert.doesNotMatch(tools, /active channels are\s+\/\/ Instagram and email/);
  assert.match(tools, /normalizePlan\(c\.business\.plan\)/);
  assert.match(tools, /getTikTokConnection\(c\.db, c\.ownerId/);
  assert.match(tools, /getYouTubeConnection\(c\.db, c\.ownerId/);
  assert.match(tools, /integrations: \{ instagram: instagram\.connected, tiktok: tiktok\?\.connected === true, youtube: youtube\?\.connected === true \}/);
  // The tool surface still can never publish, send or spend.
  assert.match(tools, /publishingAvailable: false/);
  assert.match(tools, /sendingAvailable: false/);
  assert.match(tools, /adSpendAvailable: false/);
  assert.match(tools, /does not enable sending/);
});

test("the legacy MARA drafts route is documented as retained, and the live actions route is untouched", async () => {
  const [drafts, actions] = await Promise.all([
    read("app/api/mara/drafts/[id]/route.ts"),
    read("app/api/mara/actions/[id]/route.ts"),
  ]);
  assert.match(drafts, /LEGACY — retained deliberately/);
  assert.match(drafts, /ONLY remaining entry point into `executeMaraTool`/);
  assert.match(drafts, /"approve_draft"/);
  assert.match(actions, /executeConfirmedAction/);
});
