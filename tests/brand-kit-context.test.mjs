/**
 * Brand Kit v2, slice 1 (docs/brand-kit-v2-design.md):
 *
 *   1. Migration 0059 applies on top of every earlier migration (real PGlite
 *      Postgres). A user can read and append only their own versions and can
 *      never update or delete one; the `brand-kit` bucket is private.
 *   2. The reader (`lib/brand/context.ts`) turns a kit row into prompt extras,
 *      tolerates garbage, and fails OPEN to "no kit" so generation never stops.
 *   3. Every generation payload carries `brandKit` only when a kit has content,
 *      and the system prompts are byte-for-byte unchanged without one.
 *   4. Onboarding and the Settings brand save append a new version (dual
 *      write) and still succeed when that insert fails.
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";

import { createSupabaseLite } from "./helpers/pglite-supabase.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

// Stubs for the Next server modules that lib/voom/mutations.ts imports.
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
      return { url: `data:text/javascript,${encodeURIComponent("export async function createClient() { return globalThis.__VOOM_FAKE_SUPABASE__; }")}`, shortCircuit: true };
    }
    if (specifier === "@/utils/supabase/admin") {
      return { url: `data:text/javascript,${encodeURIComponent("export function createAdminClient() { throw new Error('supabase_admin_not_configured'); }")}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const brand = await import("../lib/brand/context.ts");
const versions = await import("../lib/brand/versions.ts");
const postPrompt = await import("../lib/post/prompt.ts");
const planPrompt = await import("../lib/voom/workflow/prompt.ts");
const { saveBrandSettings, saveOnboarding } = await import("../lib/voom/mutations.ts");

const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";

const KIT_ROW = {
  version: 3,
  brief: "Bean & Co. roasts small batches in Deira and serves the people who live around it.",
  answers: {
    offerings: ["Single-origin espresso", "Weekend brunch"],
    avoid: { rules: ["Not salesy", "No stock-photo people"], words: ["cheap", "deal"] },
    facts_confirmed: ["Roasting since 2014"],
    notes: "Always mention we are family-run.",
    voice_samples: { liked: ["Morning light, first pour. Come sit with us."], disliked: ["BEST COFFEE IN TOWN!!! 50% OFF"] },
  },
};

/* ── 1. Migration 0059 ───────────────────────────────────────────────────── */

test("migration 0059 applies after every earlier migration and keeps versions append-only per owner", async () => {
  const { db, applied } = await createSupabaseLite();
  assert.equal(applied.at(-1), "0059_brand_kits.sql", "0059 is the newest migration");

  const columns = await db.query(
    "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'brand_kits' order by ordinal_position",
  );
  assert.deepEqual(columns.rows.map((row) => row.column_name), [
    "id", "owner_user_id", "version", "answers", "brief", "assets", "source", "change_summary", "changed_keys", "created_at",
  ]);

  const bucket = await db.query("select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'brand-kit'");
  assert.deepEqual(bucket.rows, [{ public: false, file_size_limit: 10485760, allowed_mime_types: ["image/jpeg", "image/png", "image/webp"] }]);

  await db.exec(`insert into auth.users (id, email) values ('${OWNER_A}', 'a@example.com'), ('${OWNER_B}', 'b@example.com');`);

  const asUser = async (uid) => {
    await db.exec(`set request.jwt.claim.sub = '${uid}'; set role authenticated;`);
  };
  const asServer = async () => {
    await db.exec("reset role; set request.jwt.claim.sub = '';");
  };

  // Owner A appends two versions of their own kit.
  await asUser(OWNER_A);
  await db.exec(`insert into public.brand_kits (owner_user_id, version, answers, source) values ('${OWNER_A}', 1, '{"name":"Bean & Co."}', 'onboarding');`);
  await db.exec(`insert into public.brand_kits (owner_user_id, version, answers, brief, source, change_summary) values ('${OWNER_A}', 2, '{"name":"Bean & Co."}', 'Small-batch roaster.', 'brand_hub', 'Brief written');`);
  // The same version number twice is refused: history has one row per version.
  await assert.rejects(
    () => db.exec(`insert into public.brand_kits (owner_user_id, version, answers, source) values ('${OWNER_A}', 2, '{}', 'brand_hub');`),
    /unique|duplicate/i,
  );
  // Only the three known sources are accepted.
  await assert.rejects(
    () => db.exec(`insert into public.brand_kits (owner_user_id, version, answers, source) values ('${OWNER_A}', 3, '{}', 'import');`),
    /check|violates/i,
  );
  // History is immutable for users: no update or delete grant.
  await assert.rejects(() => db.exec("update public.brand_kits set brief = 'x' where version = 2;"), /permission denied/i);
  await assert.rejects(() => db.exec("delete from public.brand_kits where version = 2;"), /permission denied/i);

  // Owner B sees nothing of A's and cannot write rows in A's name.
  await asUser(OWNER_B);
  const seenByB = await db.query("select version from public.brand_kits");
  assert.deepEqual(seenByB.rows, [], "RLS hides another owner's versions");
  await assert.rejects(
    () => db.exec(`insert into public.brand_kits (owner_user_id, version, answers, source) values ('${OWNER_A}', 3, '{}', 'brand_hub');`),
    /row-level security|policy/i,
  );

  // The server (service role path) reads everything, filtered by owner in code.
  await asServer();
  const all = await db.query("select owner_user_id, version from public.brand_kits order by version");
  assert.deepEqual(all.rows, [{ owner_user_id: OWNER_A, version: 1 }, { owner_user_id: OWNER_A, version: 2 }]);
});

test("migration 0059 touches nothing that exists already", async () => {
  const sql = (await read("supabase/migrations/0059_brand_kits.sql")).split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");
  assert.match(sql, /^begin;/m);
  assert.match(sql, /^commit;/m);
  assert.doesNotMatch(sql, /alter table public\.(businesses|profiles|mara_drafts|voom_email_brands)/i, "no existing table is altered");
  assert.doesNotMatch(sql, /\bdrop (table|column)\b|truncate/i, "nothing is destroyed");
  assert.doesNotMatch(sql, /pg_cron|cron\.schedule/i, "no timer");
  assert.match(sql, /for insert to authenticated with check \(\(select auth\.uid\(\)\) = owner_user_id\)/);
  assert.doesNotMatch(sql, /for (update|delete) to authenticated/i, "users never get an update or delete policy");
});

/* ── 2. The reader ───────────────────────────────────────────────────────── */

test("a kit row becomes capped prompt extras; garbage becomes the empty kit", () => {
  const extras = brand.brandKitExtrasFromRow(KIT_ROW);
  assert.equal(extras.version, 3);
  assert.deepEqual(extras.offerings, ["Single-origin espresso", "Weekend brunch"]);
  assert.deepEqual(extras.avoidRules, ["Not salesy", "No stock-photo people"]);
  assert.deepEqual(extras.bannedWords, ["cheap", "deal"]);
  assert.deepEqual(extras.facts, ["Roasting since 2014"]);
  assert.equal(extras.notes, "Always mention we are family-run.");
  assert.deepEqual(extras.voiceSamples, { liked: ["Morning light, first pour. Come sit with us."], disliked: ["BEST COFFEE IN TOWN!!! 50% OFF"] });
  assert.equal(brand.brandKitHasContent(extras), true);

  for (const row of [null, undefined, {}, { answers: "nope" }, { answers: [1, 2] }, { answers: { avoid: "x", offerings: 7, voice_samples: null }, version: "3" }]) {
    const empty = brand.brandKitExtrasFromRow(row);
    assert.deepEqual(empty, brand.EMPTY_BRAND_KIT, `row ${JSON.stringify(row)} must read as an empty kit`);
    assert.equal(brand.brandKitHasContent(empty), false);
  }

  // Caps: long lists and long text are trimmed before they reach a prompt.
  const big = brand.brandKitExtrasFromRow({ version: 1, brief: "b".repeat(5000), answers: { offerings: Array.from({ length: 40 }, (_, i) => `item ${i}`), notes: "n".repeat(2000) } });
  assert.equal(big.brief.length, 2500);
  assert.equal(big.offerings.length, 20);
  assert.equal(big.notes.length, 800);
});

function fakeDb({ kitRow = null, business = {}, profile = null, kitError = null, throwOnKit = false } = {}) {
  const calls = { inserts: [] };
  const chain = (result) => {
    const q = {
      select: () => q, eq: () => q, order: () => q, limit: () => q,
      maybeSingle: async () => result,
    };
    return q;
  };
  const client = {
    calls,
    from(table) {
      if (table === "brand_kits") {
        if (throwOnKit) throw new TypeError("db.from(...).select is not a function");
        const q = chain({ data: kitRow, error: kitError });
        q.insert = async (row) => { calls.inserts.push(row); return { error: null }; };
        return q;
      }
      if (table === "businesses") return chain({ data: business, error: null });
      if (table === "profiles") return chain({ data: profile, error: null });
      throw new Error(`unexpected table ${table}`);
    },
  };
  return client;
}

test("loadBrandKit reads the newest version and fails open to the empty kit", async () => {
  const warnings = [];
  const original = console.error;
  console.error = (...args) => warnings.push(args.join(" "));
  try {
    assert.deepEqual(await brand.loadBrandKit(fakeDb({ kitRow: KIT_ROW }), OWNER_A), brand.brandKitExtrasFromRow(KIT_ROW));
    assert.deepEqual(await brand.loadBrandKit(fakeDb(), OWNER_A), brand.EMPTY_BRAND_KIT, "no row = empty kit");
    assert.deepEqual(await brand.loadBrandKit(fakeDb({ kitError: { message: "relation brand_kits does not exist" } }), OWNER_A), brand.EMPTY_BRAND_KIT, "a database error = empty kit");
    assert.deepEqual(await brand.loadBrandKit(fakeDb({ throwOnKit: true }), OWNER_A), brand.EMPTY_BRAND_KIT, "a thrown error = empty kit");
    assert.equal(warnings.filter((line) => line.startsWith("[brand-kit] read failed")).length, 2, "both failures are logged, never thrown");
  } finally {
    console.error = original;
  }
});

test("loadBrandContext keeps today's core fields from businesses and adds the kit", async () => {
  const business = {
    brand_name: null, brand_description: "We roast our own beans.", industry: "Restaurant / Café",
    target_customer: ["Local residents nearby", "Families"], main_goal: "More walk-in customers",
    brand_personality: ["Friendly"], content_frequency: "2-3x_week",
  };
  const context = await brand.loadBrandContext(fakeDb({ kitRow: KIT_ROW, business, profile: { display_name: "Alex" } }), OWNER_A);
  assert.equal(context.brandName, "Alex", "the display name still backs a missing brand name");
  assert.deepEqual(context.targetCustomer, ["Local residents nearby", "Families"]);
  assert.deepEqual(context.brandPersonality, ["Friendly"]);
  assert.equal(context.kit.version, 3);

  const noKit = await brand.loadBrandContext(fakeDb({ business }), OWNER_A);
  assert.deepEqual(noKit.kit, brand.EMPTY_BRAND_KIT);
  assert.equal(noKit.brandName, "Your business");

  assert.equal(await brand.loadBrandContext(fakeDb({ business: null }), OWNER_A), null, "no business row = null, as before");
});

/* ── 3. Prompts and payloads ─────────────────────────────────────────────── */

const BRAND = { brandName: "Bean & Co.", brandDescription: "We roast our own beans.", industry: "Restaurant / Café", targetCustomer: "Local residents", mainGoal: "Footfall", brandPersonality: "Friendly", contentFrequency: "2-3x_week" };

test("generation payloads carry brandKit only when the kit has content", () => {
  const kit = brand.brandKitExtrasFromRow(KIT_ROW);
  const promptKit = brand.brandKitPromptContext(kit);
  assert.deepEqual(promptKit, {
    brief: KIT_ROW.brief,
    offerings: ["Single-origin espresso", "Weekend brunch"],
    mustAvoid: ["Not salesy", "No stock-photo people"],
    bannedWords: ["cheap", "deal"],
    factsYouMayState: ["Roasting since 2014"],
    ownerNotes: "Always mention we are family-run.",
    voiceSamples: { soundsLikeUs: ["Morning light, first pour. Come sit with us."], notUs: ["BEST COFFEE IN TOWN!!! 50% OFF"] },
  });
  assert.equal(brand.brandKitPromptContext(brand.EMPTY_BRAND_KIT), null);
  assert.equal(brand.brandKitPromptContext(undefined), null);

  // Post Studio: copy, Story and import suggestions. The loader hands the
  // prompt block over as `brand.brandKit` (null for an empty kit).
  const base = { brand: BRAND, plan: null, format: "1:1", kind: "instagram_post" };
  assert.equal("brandKit" in postPrompt.buildPostContextPayload(base), false, "no kit = payload unchanged");
  assert.equal("brandKit" in postPrompt.buildPostContextPayload({ ...base, brand: { ...BRAND, brandKit: null } }), false, "empty kit = payload unchanged");
  const withKit = postPrompt.buildPostContextPayload({ ...base, brand: { ...BRAND, brandKit: promptKit } });
  assert.deepEqual(withKit.brandKit, promptKit);
  assert.equal(withKit.business.name, "Bean & Co.", "the business block is untouched");

  const existing = { displayName: "a.jpg", mimeType: "image/jpeg", byteSize: 10, assetKind: "image", brand: BRAND, plan: null, nowIso: "2026-10-22T10:00:00.000Z" };
  assert.equal("brandKit" in postPrompt.buildExistingContentPayload(existing), false);
  assert.deepEqual(postPrompt.buildExistingContentPayload({ ...existing, brand: { ...BRAND, brandKit: promptKit } }).brandKit, promptKit);
  assert.doesNotMatch(JSON.stringify(postPrompt.buildExistingContentPayload({ ...existing, brand: { ...BRAND, brandKit: promptKit } })), /base64|dataUrl|Uint8Array/i, "still no media bytes");

  // Weekly plan slot.
  const slot = { business: { name: "Bean & Co." }, goal: "Footfall", cadenceLabel: "Daily", channel: "instagram", format: "post", localDate: "2026-10-22", localTime: "6:30 pm", timezone: "Asia/Dubai", recentConcepts: [] };
  assert.deepEqual(planPrompt.buildPlannedContentPayload(slot), planPrompt.buildPlannedContentPayload({ ...slot, brandKit: null }));
  assert.equal("brandKit" in planPrompt.buildPlannedContentPayload(slot), false);
  assert.deepEqual(planPrompt.buildPlannedContentPayload({ ...slot, brandKit: promptKit }).brandKit, promptKit);
});

test("system prompts are unchanged without a kit and gain the BRAND KIT rules with one", () => {
  const kit = brand.brandKitPromptContext(brand.brandKitExtrasFromRow(KIT_ROW));
  assert.equal(brand.withBrandKitRules(postPrompt.POST_COPY_SYSTEM_PROMPT, null), postPrompt.POST_COPY_SYSTEM_PROMPT);
  assert.equal(brand.withBrandKitRules(postPrompt.POST_COPY_SYSTEM_PROMPT, undefined), postPrompt.POST_COPY_SYSTEM_PROMPT);
  const ruled = brand.withBrandKitRules(postPrompt.POST_COPY_SYSTEM_PROMPT, kit);
  assert.ok(ruled.startsWith(postPrompt.POST_COPY_SYSTEM_PROMPT), "the original prompt is kept verbatim");
  assert.match(ruled, /\nBRAND KIT\n/);
  for (const rule of brand.BRAND_KIT_RULES) assert.ok(ruled.includes(`- ${rule}`), `rule present: ${rule.slice(0, 40)}`);
  assert.match(ruled, /bannedWords must not appear anywhere in the output/);
  assert.match(ruled, /factsYouMayState are the ONLY specific facts/);

  assert.equal(planPrompt.plannedContentSystemPrompt({ trendEvidence: false }), planPrompt.PLANNED_CONTENT_SYSTEM_PROMPT, "flag-off, no kit: identical");
  assert.equal(planPrompt.plannedContentSystemPrompt({ trendEvidence: false, brandKit: null }), planPrompt.PLANNED_CONTENT_SYSTEM_PROMPT);
  const both = planPrompt.plannedContentSystemPrompt({ trendEvidence: true, brandKit: kit });
  assert.ok(both.indexOf("TREND EVIDENCE") < both.indexOf("BRAND KIT"), "trend rules first, then brand kit rules");
});

test("Post Studio routes and the weekly plan wire the kit into their prompts", async () => {
  const generate = await read("app/api/posts/[id]/generate/route.ts");
  assert.match(generate, /const brandKit = brand\.brandKit \?\? null/);
  assert.match(generate, /withBrandKitRules\(STORY_VISUAL_SYSTEM_PROMPT, brandKit\)/);
  assert.match(generate, /withBrandKitRules\(POST_COPY_SYSTEM_PROMPT, brandKit\)/);
  const suggest = await read("app/api/posts/[id]/suggest/route.ts");
  assert.match(suggest, /withBrandKitRules\(POST_SUGGESTION_SYSTEM_PROMPT, brand\.brandKit\)/);
  const serverData = await read("lib/post/server-data.ts");
  assert.match(serverData, /const context = await loadBrandContext\(admin, ownerId\)/, "Post Studio reads through the one brand reader");
  assert.match(serverData, /brandKit: brandKitPromptContext\(context\.kit\)/, "the loader builds the prompt block once");
  const postPromptSource = await read("lib/post/prompt.ts");
  assert.doesNotMatch(postPromptSource, /^import \{[^}]*\} from "@\/lib\/brand\/context"/m, "lib/post/prompt.ts stays dependency-free at runtime (type-only import)");
  const service = await read("lib/voom/workflow/service.ts");
  assert.match(service, /const brandKit = brandKitPromptContext\(await loadBrandKit\(admin, input\.ownerId\)\)/, "the plan reads the kit once per run");
  assert.match(service, /brandKit: context\.brandKit \?\? null/, "every slot prompt receives it");
  assert.match(service, /plannedContentSystemPrompt\(\{ trendEvidence: Boolean\(input\.trendOpportunity\), brandKit: input\.brandKit \?\? null \}\)/);
});

/* ── 4. Dual write from onboarding and Settings ─────────────────────────── */

function profileInput(overrides = {}) {
  return {
    displayName: "Alex", brandName: "Bean & Co.", brandDescription: "We roast our own beans.", industry: "Restaurant / Café",
    targetCustomer: ["Local residents nearby"], mainGoal: "More walk-in customers", brandPersonality: ["Friendly"],
    preferredChannels: ["Instagram"], monthlyAdBudget: "", contentFrequency: "2-3x_week", automationLevel: "assisted", publishingPermission: "",
    ...overrides,
  };
}

function fakeUserDb({ newestVersion = null, newestRow = null, insertError = null } = {}) {
  const calls = { upserts: [], kitInserts: [] };
  const chain = (result) => {
    const q = { select: () => q, eq: () => q, order: () => q, limit: () => q, maybeSingle: async () => result };
    return q;
  };
  globalThis.__VOOM_FAKE_SUPABASE__ = {
    from(table) {
      if (table === "brand_kits") {
        const q = chain({ data: newestRow ?? (newestVersion ? { version: newestVersion, answers: {}, brief: null } : null), error: null });
        q.insert = async (row) => { calls.kitInserts.push(row); return { error: insertError }; };
        return q;
      }
      return {
        upsert: async (payload) => { calls.upserts.push({ table, payload }); return { error: null, data: { id: "row-1" } }; },
      };
    },
    auth: { getClaims: async () => ({ data: { claims: { sub: "owner-1", email: "owner@example.com" } }, error: null }) },
  };
  return calls;
}

test("onboarding and Settings saves append the next brand kit version and still write businesses", async () => {
  const first = fakeUserDb();
  assert.deepEqual(await saveOnboarding(profileInput()), { ok: true });
  assert.equal(first.upserts.filter((call) => call.table === "businesses").length, 1, "businesses is still written");
  assert.equal(first.kitInserts.length, 1);
  assert.equal(first.kitInserts[0].owner_user_id, "owner-1");
  assert.equal(first.kitInserts[0].version, 1, "first save = version 1");
  assert.equal(first.kitInserts[0].source, "onboarding");
  assert.deepEqual(first.kitInserts[0].answers, versions.brandKitAnswersFromProfile(profileInput()));
  assert.equal(first.kitInserts[0].answers.name, "Bean & Co.");
  assert.deepEqual(first.kitInserts[0].answers.audience, ["Local residents nearby"]);

  const later = fakeUserDb({ newestVersion: 4 });
  assert.deepEqual(await saveBrandSettings(profileInput({ industry: "Retail" })), { ok: true });
  assert.equal(later.kitInserts[0].version, 5, "a Settings save appends newest + 1");
  assert.equal(later.kitInserts[0].source, "brand_hub");
  assert.equal(later.kitInserts[0].answers.category, "Retail");
});

test("a save replaces only the fields it owns and carries every other field forward", () => {
  const previous = {
    answers: { name: "Bean & Co.", personality: ["Friendly", "Professional"], avoid: { rules: ["Not salesy"], words: ["cheap"] }, notes: "Always mention we are family-run." },
    brief: "Small-batch roaster in Deira.",
  };
  // The personality screen saves Professional + Bold: Friendly goes, the rest stays.
  const edit = versions.mergeBrandKitVersion(previous, { answers: { personality: ["Professional", "Bold"] } });
  assert.deepEqual(edit.answers.personality, ["Professional", "Bold"], "the whole field is replaced, nothing is merged inside it");
  assert.deepEqual(edit.answers.avoid, previous.answers.avoid, "fields the save did not own carry over");
  assert.equal(edit.answers.notes, previous.answers.notes);
  assert.equal(edit.brief, previous.brief, "the brief carries over when not given");
  assert.deepEqual(edit.changedKeys, ["personality"]);

  // Saving the same value again changes nothing and the history says so.
  assert.deepEqual(versions.mergeBrandKitVersion(previous, { answers: { name: "Bean & Co." } }).changedKeys, []);

  // Clearing a field the screen shows really clears it; clearing the brief too.
  const cleared = versions.mergeBrandKitVersion(previous, { answers: { notes: "" }, brief: "" });
  assert.equal(cleared.answers.notes, "");
  assert.equal(cleared.brief, null);
  assert.deepEqual(cleared.changedKeys, ["notes", "brief"]);

  // No previous version: the save is the whole kit.
  const first = versions.mergeBrandKitVersion(null, { answers: { name: "Bean & Co." }, brief: "Hello." });
  assert.deepEqual(first, { answers: { name: "Bean & Co." }, brief: "Hello.", changedKeys: ["name", "brief"] });
});

test("a Settings save never wipes the brief, rules, facts or notes of the newest version", async () => {
  const newestRow = { version: 3, brief: KIT_ROW.brief, answers: { ...KIT_ROW.answers, name: "Bean & Co.", category: "Restaurant / Café" } };
  const calls = fakeUserDb({ newestRow });
  assert.deepEqual(await saveBrandSettings(profileInput({ industry: "Retail" })), { ok: true });
  const inserted = calls.kitInserts[0];
  assert.equal(inserted.version, 4);
  assert.equal(inserted.brief, KIT_ROW.brief, "the brief survives a Settings save");
  assert.deepEqual(inserted.answers.avoid, KIT_ROW.answers.avoid, "the rules survive");
  assert.deepEqual(inserted.answers.facts_confirmed, KIT_ROW.answers.facts_confirmed);
  assert.equal(inserted.answers.notes, KIT_ROW.answers.notes);
  assert.deepEqual(inserted.answers.voice_samples, KIT_ROW.answers.voice_samples);
  assert.equal(inserted.answers.category, "Retail", "the field Settings owns is replaced");
  assert.ok(inserted.changed_keys.includes("category"));
  assert.equal(inserted.changed_keys.includes("notes"), false);
  // MARA reads the merged row exactly as a kit with content.
  assert.equal(brand.brandKitHasContent(brand.brandKitExtrasFromRow(inserted)), true);
});

test("a failed brand kit insert is logged and never fails the user's save", async () => {
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const failing = fakeUserDb({ insertError: { message: "relation \"public.brand_kits\" does not exist" } });
    assert.deepEqual(await saveBrandSettings(profileInput()), { ok: true });
    assert.equal(failing.upserts.filter((call) => call.table === "businesses").length, 1);
    assert.equal(logged.filter((line) => line.includes("[brand-kit] version insert failed")).length, 1);
  } finally {
    console.error = original;
  }
});
