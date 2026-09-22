/**
 * Regression tests — the Settings save must never silently wipe
 * `businesses.brand_description` (or any other field the Settings screen
 * round-trips).
 *
 * Root cause under test: the client Brand state once had no `desc` field, so
 * the Settings form could only send `brandDescription: ""`, and the save
 * action's `trim() || null` turned that into a destructive `brand_description =
 * NULL` on every "Save changes".
 *
 * These tests execute the REAL data path:
 *   businesses row -> brandFromBusiness (lib/voom/brand-state.ts)
 *   -> Settings payload shape (mirrored from app/app/(shell)/settings/page.tsx,
 *      which is .tsx and cannot be imported by bare Node)
 *   -> saveBrandSettings / saveOnboarding (lib/voom/mutations.ts, executed
 *      against a fake Supabase client that records the exact upsert payload)
 *   -> reload through brandFromBusiness.
 */
import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

// ── Stubs for the Next server modules the mutations module imports ─────────
// Registered AFTER the shared shim, so these exact specifiers win and every
// other specifier falls through to the shim / default resolver.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/cache") {
      return {
        url: `data:text/javascript,${encodeURIComponent(
          "export function revalidatePath() {}",
        )}`,
        shortCircuit: true,
      };
    }
    if (specifier === "next/headers") {
      return {
        url: `data:text/javascript,${encodeURIComponent(
          "export async function cookies() { return { getAll: () => [], set: () => {} }; }",
        )}`,
        shortCircuit: true,
      };
    }
    if (specifier === "@/utils/supabase/server") {
      return {
        url: `data:text/javascript,${encodeURIComponent(
          "export async function createClient() { return globalThis.__VOOM_FAKE_SUPABASE__; }",
        )}`,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

const { saveBrandSettings, saveOnboarding } = await import("../lib/voom/mutations.ts");
const { brandFromBusiness, emptyBrand } = await import("../lib/voom/brand-state.ts");

// A full business row with a distinct marker per persisted column.
function businessRow(overrides = {}) {
  return {
    id: "biz-1",
    owner_user_id: "owner-1",
    brand_name: "Bean & Co.",
    brand_description: "We roast our own beans.",
    industry: "Restaurant / Café",
    target_customer: ["Local residents nearby", "Families with children"],
    main_goal: "More walk-in customers",
    brand_personality: ["Friendly", "Calm"],
    preferred_channels: ["Instagram", "Email"],
    monthly_ad_budget: "AED 1,000 – 3,000",
    content_frequency: "2-3x_week",
    automation_level: "assisted",
    publishing_permission: "No — publish automatically",
    plan: "free",
    onboarding_completed: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** The exact payload shape the Settings form builds in handleSave(). */
function settingsPayloadFromBrand(brand, displayName) {
  return {
    displayName,
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
  };
}

function makeFakeDb(initialRow) {
  const row = { ...initialRow };
  const calls = { profilesUpsert: [], businessesUpsert: [] };
  const fake = {
    calls,
    row,
    client: {
      from(table) {
        return {
          upsert: async (payload) => {
            if (table === "profiles") calls.profilesUpsert.push(payload);
            if (table === "businesses") {
              calls.businessesUpsert.push(payload);
              Object.assign(row, payload);
            }
            return { error: null, data: { id: "row-1" } };
          },
          update: async () => ({ error: null, data: [] }),
        };
      },
      auth: {
        getClaims: async () => ({
          data: { claims: { sub: "owner-1", email: "owner@example.com" } },
          error: null,
        }),
      },
    },
  };
  globalThis.__VOOM_FAKE_SUPABASE__ = fake.client;
  return fake;
}

test("existing brand_description loads into the client brand state", () => {
  const brand = brandFromBusiness(businessRow());
  assert.equal(brand.desc, "We roast our own beans.");

  // A row without a description must load as an empty string, never a
  // dropped field.
  const bare = brandFromBusiness(businessRow({ brand_description: null }));
  assert.equal(bare.desc, "");
  assert.equal(emptyBrand().desc, "");
});

test("unrelated Settings save preserves the existing description exactly", async () => {
  const row = businessRow();
  const brand = brandFromBusiness(row);
  const fake = makeFakeDb(row);

  // The user only changed the industry; every other payload value comes from
  // the loaded brand state, exactly as the Settings form assembles it.
  const payload = settingsPayloadFromBrand(brand, "Alex");
  payload.industry = "Salon / Spa";

  const result = await saveBrandSettings(payload);
  assert.equal(result.ok, true);
  assert.equal(fake.calls.businessesUpsert.length, 1);
  assert.equal(fake.calls.businessesUpsert[0].brand_description, "We roast our own beans.");
  assert.equal(fake.calls.businessesUpsert[0].industry, "Salon / Spa");
});

test("editing the description persists the new value", async () => {
  const fake = makeFakeDb(businessRow());
  const brand = brandFromBusiness(fake.row);
  const payload = settingsPayloadFromBrand(brand, "Alex");
  payload.brandDescription = "Family run since 1998. Fresh bread, no shortcuts.";

  const result = await saveBrandSettings(payload);
  assert.equal(result.ok, true);
  assert.equal(
    fake.calls.businessesUpsert[0].brand_description,
    "Family run since 1998. Fresh bread, no shortcuts.",
  );
});

test("explicitly clearing the description stores null", async () => {
  const fake = makeFakeDb(businessRow());
  const brand = brandFromBusiness(fake.row);
  const payload = settingsPayloadFromBrand(brand, "Alex");
  payload.brandDescription = "";

  const result = await saveBrandSettings(payload);
  assert.equal(result.ok, true);
  assert.equal(fake.calls.businessesUpsert[0].brand_description, null);
});

test("reload after save returns the saved value", async () => {
  const fake = makeFakeDb(businessRow());
  const brand = brandFromBusiness(fake.row);

  // Edit and save.
  const edited = settingsPayloadFromBrand(brand, "Alex");
  edited.brandDescription = "Updated description.";
  assert.equal((await saveBrandSettings(edited)).ok, true);
  assert.equal(brandFromBusiness(fake.row).desc, "Updated description.");

  // Explicit clear and save.
  const cleared = settingsPayloadFromBrand(brandFromBusiness(fake.row), "Alex");
  cleared.brandDescription = "";
  assert.equal((await saveBrandSettings(cleared)).ok, true);
  assert.equal(brandFromBusiness(fake.row).desc, "");
});

test("onboarding still writes the wizard description", async () => {
  const fake = makeFakeDb(businessRow({ brand_description: null, onboarding_completed: false }));
  const result = await saveOnboarding({
    displayName: "Alex",
    brandName: "Bean & Co.",
    brandDescription: "We roast our own beans.",
    industry: "Restaurant / Café",
    targetCustomer: ["Local residents nearby"],
    mainGoal: "More walk-in customers",
    brandPersonality: ["Friendly"],
    preferredChannels: ["Instagram"],
    monthlyAdBudget: "AED 0 — organic only",
    contentFrequency: "2-3x_week",
    automationLevel: "assisted",
    publishingPermission: "Yes — always ask first",
  });
  assert.equal(result.ok, true);
  assert.equal(fake.calls.businessesUpsert[0].brand_description, "We roast our own beans.");
});

test("no other Settings-saved field can be silently reset by load-then-save", async () => {
  // Every column the Settings screen round-trips must survive a
  // load -> unchanged save -> reload cycle with its exact value. This is the
  // same class of bug as the brand_description wipe: any field missing from
  // the client mapping would surface here as an empty-string reset.
  const row = businessRow();
  const fake = makeFakeDb(row);
  const payload = settingsPayloadFromBrand(brandFromBusiness(row), "Alex");

  assert.equal((await saveBrandSettings(payload)).ok, true);
  const saved = fake.calls.businessesUpsert[0];

  assert.equal(saved.brand_name, row.brand_name);
  assert.equal(saved.brand_description, row.brand_description);
  assert.equal(saved.industry, row.industry);
  assert.deepEqual(saved.target_customer, row.target_customer);
  assert.equal(saved.main_goal, row.main_goal);
  assert.deepEqual(saved.brand_personality, row.brand_personality);
  assert.deepEqual(saved.preferred_channels, row.preferred_channels);
  assert.equal(saved.monthly_ad_budget, row.monthly_ad_budget);
  assert.equal(saved.content_frequency, row.content_frequency);
  assert.equal(saved.automation_level, row.automation_level);
  assert.equal(saved.publishing_permission, row.publishing_permission);

  // And the reload must show exactly what was saved.
  assert.deepEqual(brandFromBusiness(fake.row).desc, row.brand_description);
});

test("Settings form binds the persisted description and never hardcodes an empty one", async () => {
  const [settings, store, brandState] = await Promise.all([
    read("app/app/(shell)/settings/page.tsx"),
    read("lib/voom/store.tsx"),
    read("lib/voom/brand-state.ts"),
  ]);

  // The form loads the stored value into its own state...
  assert.match(settings, /useState\(brand\.desc\)/);
  // ...and the save payload sends that state, not a literal "".
  assert.match(settings, /brandDescription: descInput/);
  assert.doesNotMatch(settings, /brandDescription: ""/);
  // The description is editable (an explicit clear is the only path to null).
  assert.match(settings, /value=\{descInput\}/);
  assert.match(settings, /onChange=\{\(e\) => setDescInput\(e\.target\.value\)\}/);

  // Both client state updates carry the description so it is never stale.
  assert.match(store, /desc: input\.brandDescription/);
  assert.match(store, /desc: payload\.brandDescription/);
  assert.doesNotMatch(store, /interface Brand \{/);

  // The single mapping lives in the pure module and loads the column.
  assert.match(brandState, /desc: business\.brand_description \?\? ""/);
});
