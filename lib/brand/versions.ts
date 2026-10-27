/**
 * Brand Kit v2, slice 1: appending a version row.
 *
 * `brand_kits` (migration 0059) is append-only: every save inserts
 * version = newest + 1 for the owner. Row-level security lets a user insert
 * only their own rows, so this runs fine on the user-scoped client.
 *
 * The write is best-effort by design: onboarding and Settings already saved
 * the `businesses` row (today's source for the core fields), so a failed kit
 * insert is logged and never fails the user's save.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { BRAND_KIT_TABLE } from "./context";
import type { BrandAsset } from "./assets";
import type { BusinessProfileInput, OnboardingInput } from "@/lib/voom/types";

export type BrandKitSource = "onboarding" | "brand_hub" | "extraction";

export interface BrandKitVersionInput {
  source: BrandKitSource;
  /** Only the fields this save owns; everything else carries over from the previous version. */
  answers: Record<string, unknown>;
  /** Omit to keep the previous brief; null or "" clears it. */
  brief?: string | null;
  /** Slice 5: omit to keep the previous asset list; an array replaces it in full (same rule as every field). */
  assets?: BrandAsset[];
  changeSummary?: string;
  changedKeys?: string[];
}

/**
 * The field-map keys for what the current wizard and Settings form collect.
 * Later slices add offerings, avoid, facts_confirmed, notes, voice_samples.
 */
export function brandKitAnswersFromProfile(input: BusinessProfileInput): Record<string, unknown> {
  return {
    name: input.brandName.trim(),
    description: input.brandDescription.trim(),
    category: input.industry,
    audience: input.targetCustomer,
    goal: input.mainGoal,
    personality: input.brandPersonality,
    channels: input.preferredChannels,
    pace: input.contentFrequency,
    automation: input.automationLevel,
    budget: input.monthlyAdBudget,
    publishing_permission: input.publishingPermission,
  };
}

/**
 * Everything the new onboarding (Brand Kit v2, slice 3) collects, as kit
 * answers: the core profile keys plus the kit-only screens (rules, banned
 * words, notes, facts, offerings) and, when the plan refused the wanted
 * automation mode, `wanted_automation`. Budget and publishing permission are
 * no longer asked, so they are omitted rather than stored as "".
 *
 * Slice 4 adds `provenance` (answer key -> "description" for every value that
 * is MARA's reading accepted unchanged; keys the owner typed are simply
 * absent) and `facts_unconfirmed` (facts MARA found that the owner did not
 * tick; generation reads only `facts_confirmed`). Both are written only when
 * non-empty.
 */
export function brandKitAnswersFromOnboarding(input: OnboardingInput): Record<string, unknown> {
  const core = brandKitAnswersFromProfile(input);
  delete core.budget;
  delete core.publishing_permission;
  const kit = input.kit;
  if (!kit) return core;
  const provenance = Object.fromEntries((kit.fromDescription ?? []).map((key) => [key, "description"]));
  return {
    ...core,
    offerings: kit.offerings,
    avoid: { rules: kit.rules, words: kit.words },
    notes: kit.notes,
    facts_confirmed: kit.facts,
    ...(kit.factsUnconfirmed?.length ? { facts_unconfirmed: kit.factsUnconfirmed } : {}),
    ...(Object.keys(provenance).length ? { provenance } : {}),
    ...(kit.wantedAutomation ? { wanted_automation: kit.wantedAutomation } : {}),
    // Slice 5: the logo colours, only when there are some (a skipped screen carries the old ones forward).
    ...(kit.colours ? { colours: kit.colours } : {}),
  };
}

/** A kit version's editable content, as stored. */
export interface BrandKitContent {
  answers: Record<string, unknown>;
  brief: string | null;
}

/**
 * The ONE rule for a new version, by field, never by word: every field the
 * save owns (`input.answers` keys, plus `brief` when `input.brief` is given)
 * REPLACES the previous value in full; every other field is carried over from
 * the previous version untouched. So a Settings save that owns only the core
 * fields can never erase the brief, the rules or the notes, and clearing a
 * field the screen shows really clears it. Returns the merged content and the
 * keys whose value actually changed (for the history line).
 */
export function mergeBrandKitVersion(
  previous: BrandKitContent | null,
  input: Pick<BrandKitVersionInput, "answers" | "brief">,
): BrandKitContent & { changedKeys: string[] } {
  const base = previous?.answers && typeof previous.answers === "object" && !Array.isArray(previous.answers)
    ? previous.answers
    : {};
  const answers: Record<string, unknown> = { ...base, ...input.answers };
  const changedKeys = Object.keys(input.answers).filter((key) => JSON.stringify(base[key] ?? null) !== JSON.stringify(input.answers[key] ?? null));
  let brief = previous?.brief ?? null;
  if (input.brief !== undefined) {
    const next = input.brief?.trim() || null;
    if (next !== brief) changedKeys.push("brief");
    brief = next;
  }
  return { answers, brief, changedKeys };
}

/** Inserts the next version for the owner. Returns the version number, or null when it failed. */
export async function appendBrandKitVersion(
  db: SupabaseClient,
  ownerId: string,
  input: BrandKitVersionInput,
): Promise<number | null> {
  try {
    const { data: newest, error: readError } = await db.from(BRAND_KIT_TABLE)
      .select("version,answers,brief,assets").eq("owner_user_id", ownerId)
      .order("version", { ascending: false }).limit(1).maybeSingle();
    if (readError) throw new Error(readError.message);
    const current = typeof newest?.version === "number" ? newest.version : 0;
    const version = current + 1;
    const merged = mergeBrandKitVersion(
      newest ? { answers: (newest.answers ?? {}) as Record<string, unknown>, brief: typeof newest.brief === "string" ? newest.brief : null } : null,
      input,
    );
    // Assets follow the same rule as every field: replaced in full when the
    // save owns them, otherwise carried over untouched.
    const previousAssets = Array.isArray(newest?.assets) ? (newest.assets as unknown[]) : [];
    const assets = input.assets ?? previousAssets;
    const changedKeys = [...merged.changedKeys];
    if (input.assets !== undefined && JSON.stringify(previousAssets) !== JSON.stringify(input.assets)) changedKeys.push("assets");
    const { error } = await db.from(BRAND_KIT_TABLE).insert({
      owner_user_id: ownerId,
      version,
      answers: merged.answers,
      brief: merged.brief,
      assets,
      source: input.source,
      change_summary: input.changeSummary?.slice(0, 300) ?? null,
      changed_keys: input.changedKeys ?? changedKeys,
    });
    if (error) throw new Error(error.message);
    return version;
  } catch (reason) {
    console.error("[brand-kit] version insert failed", reason instanceof Error ? reason.message : String(reason));
    return null;
  }
}
