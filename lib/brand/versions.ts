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
import type { BusinessProfileInput } from "@/lib/voom/types";

export type BrandKitSource = "onboarding" | "brand_hub" | "extraction";

export interface BrandKitVersionInput {
  source: BrandKitSource;
  /** Only the fields this save owns; everything else carries over from the previous version. */
  answers: Record<string, unknown>;
  /** Omit to keep the previous brief; null or "" clears it. */
  brief?: string | null;
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
      .select("version,answers,brief").eq("owner_user_id", ownerId)
      .order("version", { ascending: false }).limit(1).maybeSingle();
    if (readError) throw new Error(readError.message);
    const current = typeof newest?.version === "number" ? newest.version : 0;
    const version = current + 1;
    const merged = mergeBrandKitVersion(
      newest ? { answers: (newest.answers ?? {}) as Record<string, unknown>, brief: typeof newest.brief === "string" ? newest.brief : null } : null,
      input,
    );
    const { error } = await db.from(BRAND_KIT_TABLE).insert({
      owner_user_id: ownerId,
      version,
      answers: merged.answers,
      brief: merged.brief,
      source: input.source,
      change_summary: input.changeSummary?.slice(0, 300) ?? null,
      changed_keys: input.changedKeys ?? merged.changedKeys,
    });
    if (error) throw new Error(error.message);
    return version;
  } catch (reason) {
    console.error("[brand-kit] version insert failed", reason instanceof Error ? reason.message : String(reason));
    return null;
  }
}
