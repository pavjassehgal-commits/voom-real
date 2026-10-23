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
  /** Structured answers keyed by the Brand Kit field map. */
  answers: Record<string, unknown>;
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

/** Inserts the next version for the owner. Returns the version number, or null when it failed. */
export async function appendBrandKitVersion(
  db: SupabaseClient,
  ownerId: string,
  input: BrandKitVersionInput,
): Promise<number | null> {
  try {
    const { data: newest, error: readError } = await db.from(BRAND_KIT_TABLE)
      .select("version").eq("owner_user_id", ownerId)
      .order("version", { ascending: false }).limit(1).maybeSingle();
    if (readError) throw new Error(readError.message);
    const current = typeof newest?.version === "number" ? newest.version : 0;
    const version = current + 1;
    const { error } = await db.from(BRAND_KIT_TABLE).insert({
      owner_user_id: ownerId,
      version,
      answers: input.answers,
      brief: input.brief?.trim() || null,
      source: input.source,
      change_summary: input.changeSummary?.slice(0, 300) ?? null,
      changed_keys: input.changedKeys ?? [],
    });
    if (error) throw new Error(error.message);
    return version;
  } catch (reason) {
    console.error("[brand-kit] version insert failed", reason instanceof Error ? reason.message : String(reason));
    return null;
  }
}
