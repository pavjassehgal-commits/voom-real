/**
 * Brand Kit v2, slice 1: the ONE reader generation uses for what MARA knows
 * about a brand (docs/brand-kit-v2-design.md).
 *
 * Core brand fields (name, description, category, audience, goal, personality,
 * posting pace) still come from `public.businesses`, exactly as before. The
 * newest `public.brand_kits` row (migration 0059) only ADDS context on top:
 * the confirmed brief, what the business offers, rules to avoid, banned words,
 * facts MARA may state, owner notes and voice samples. An account with no kit
 * row gets empty extras and generation behaves exactly as it did.
 *
 * Reading the kit never throws: any failure (table not applied yet, bad JSON,
 * network) is logged and treated as "no kit", because a missing kit must never
 * stop a plan or a post from being written.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const BRAND_KIT_TABLE = "brand_kits";

/** Extras the kit adds to every prompt. Every field has a safe empty value. */
export interface BrandKitExtras {
  /** Newest version number, or null when the account has no kit row. */
  version: number | null;
  /** The confirmed Brand Brief paragraphs (plain text). */
  brief: string;
  /** What the business sells or does. */
  offerings: string[];
  /** Things MARA must never do ("Not salesy", "No stock-photo people"). */
  avoidRules: string[];
  /** Words, topics or emoji that must not appear in copy. */
  bannedWords: string[];
  /** Facts the owner confirmed MARA may state ("Roasting since 2014"). */
  facts: string[];
  /** Anything specific the owner wants MARA to know or do. */
  notes: string;
  /** Captions the owner marked "sounds like us" / "not us". */
  voiceSamples: { liked: string[]; disliked: string[] };
}

export const EMPTY_BRAND_KIT: BrandKitExtras = Object.freeze({
  version: null,
  brief: "",
  offerings: [],
  avoidRules: [],
  bannedWords: [],
  facts: [],
  notes: "",
  voiceSamples: { liked: [], disliked: [] },
}) as BrandKitExtras;

/** Caps applied before anything reaches a prompt. */
const LIMITS = {
  brief: 2500,
  listItems: 20,
  listItem: 200,
  notes: 800,
  voiceSamples: 5,
  voiceSample: 600,
} as const;

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function cleanList(value: unknown, maxItems: number = LIMITS.listItems, maxItem: number = LIMITS.listItem): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanText(item, maxItem))
    .filter(Boolean)
    .slice(0, maxItems);
}

/**
 * The shape of one `brand_kits` row as this reader needs it. Kept loose on
 * purpose: `answers` is owner-edited JSON and must never crash a prompt.
 */
export interface BrandKitRow {
  version?: unknown;
  brief?: unknown;
  answers?: unknown;
}

/** Pure mapping from a kit row (or none) to the prompt extras. */
export function brandKitExtrasFromRow(row: BrandKitRow | null | undefined): BrandKitExtras {
  if (!row || typeof row !== "object") return EMPTY_BRAND_KIT;
  const answers = row.answers && typeof row.answers === "object" && !Array.isArray(row.answers)
    ? (row.answers as Record<string, unknown>)
    : {};
  const avoid = answers.avoid && typeof answers.avoid === "object" && !Array.isArray(answers.avoid)
    ? (answers.avoid as Record<string, unknown>)
    : {};
  const voice = answers.voice_samples && typeof answers.voice_samples === "object" && !Array.isArray(answers.voice_samples)
    ? (answers.voice_samples as Record<string, unknown>)
    : {};
  const version = typeof row.version === "number" && Number.isInteger(row.version) && row.version >= 1 ? row.version : null;
  return {
    version,
    brief: cleanText(row.brief, LIMITS.brief),
    offerings: cleanList(answers.offerings),
    avoidRules: cleanList(avoid.rules),
    bannedWords: cleanList(avoid.words, 50, 60),
    facts: cleanList(answers.facts_confirmed),
    notes: cleanText(answers.notes, LIMITS.notes),
    voiceSamples: {
      liked: cleanList(voice.liked, LIMITS.voiceSamples, LIMITS.voiceSample),
      disliked: cleanList(voice.disliked, LIMITS.voiceSamples, LIMITS.voiceSample),
    },
  };
}

/** True when the kit carries anything a prompt could use. */
export function brandKitHasContent(kit: BrandKitExtras | null | undefined): boolean {
  if (!kit) return false;
  return Boolean(
    kit.brief || kit.offerings.length || kit.avoidRules.length || kit.bannedWords.length
    || kit.facts.length || kit.notes || kit.voiceSamples.liked.length || kit.voiceSamples.disliked.length,
  );
}

/**
 * Reads the newest kit for an owner. Works with the user-scoped client (RLS
 * limits it to the caller's rows) and the service-role client (filtered by
 * owner here). Never throws.
 */
export async function loadBrandKit(db: SupabaseClient, ownerId: string): Promise<BrandKitExtras> {
  try {
    const { data, error } = await db.from(BRAND_KIT_TABLE)
      .select("version,brief,answers")
      .eq("owner_user_id", ownerId)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error("[brand-kit] read failed", error.message);
      return EMPTY_BRAND_KIT;
    }
    return brandKitExtrasFromRow(data as BrandKitRow | null);
  } catch (reason) {
    console.error("[brand-kit] read failed", reason instanceof Error ? reason.message : String(reason));
    return EMPTY_BRAND_KIT;
  }
}

/** The core brand fields every generation path already reads from `businesses`. */
export interface BrandContext {
  brandName: string;
  brandDescription: string;
  industry: string;
  targetCustomer: string[];
  mainGoal: string;
  brandPersonality: string[];
  contentFrequency: string;
  kit: BrandKitExtras;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item ?? "").trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

/**
 * Core fields from `businesses` plus the kit extras. Returns null when the
 * account has no business row (onboarding not done), exactly like the Post
 * Studio loader did before.
 */
export async function loadBrandContext(db: SupabaseClient, ownerId: string): Promise<BrandContext | null> {
  const [{ data: profile }, { data: business }, kit] = await Promise.all([
    db.from("profiles").select("display_name").eq("user_id", ownerId).maybeSingle(),
    db.from("businesses")
      .select("brand_name,brand_description,industry,target_customer,main_goal,brand_personality,content_frequency")
      .eq("owner_user_id", ownerId).maybeSingle(),
    loadBrandKit(db, ownerId),
  ]);
  if (!business) return null;
  return {
    brandName: String(business.brand_name ?? profile?.display_name ?? "Your business"),
    brandDescription: String(business.brand_description ?? ""),
    industry: String(business.industry ?? ""),
    targetCustomer: stringList(business.target_customer),
    mainGoal: String(business.main_goal ?? ""),
    brandPersonality: stringList(business.brand_personality),
    contentFrequency: String(business.content_frequency ?? ""),
    kit,
  };
}

/**
 * The text-only block added to a prompt payload under the key `brandKit`.
 * Null when the kit is empty, so payloads for accounts without a kit are
 * unchanged.
 */
export function brandKitPromptContext(kit: BrandKitExtras | null | undefined) {
  if (!brandKitHasContent(kit) || !kit) return null;
  return {
    brief: kit.brief,
    offerings: kit.offerings,
    mustAvoid: kit.avoidRules,
    bannedWords: kit.bannedWords,
    factsYouMayState: kit.facts,
    ownerNotes: kit.notes,
    voiceSamples: { soundsLikeUs: kit.voiceSamples.liked, notUs: kit.voiceSamples.disliked },
  };
}

export type BrandKitPromptContext = NonNullable<ReturnType<typeof brandKitPromptContext>>;

/**
 * Rules appended to a system prompt ONLY when the payload carries a brandKit,
 * so prompts for accounts without a kit stay byte-for-byte unchanged.
 */
export const BRAND_KIT_RULES = [
  "The payload may carry brandKit: what the owner confirmed about their brand. It is the most reliable description of the business; when it conflicts with the older business fields, brandKit wins.",
  "brandKit.brief describes the brand in the owner's confirmed words. Write in that spirit.",
  "brandKit.mustAvoid lists hard rules. Never break one. brandKit.bannedWords must not appear anywhere in the output, in any casing.",
  "brandKit.factsYouMayState are the ONLY specific facts (years, awards, numbers, places) you may state about this business. Anything not listed there or in the rest of the payload stays unsaid.",
  "brandKit.voiceSamples.soundsLikeUs shows the tone the owner wants; notUs shows what they rejected. Match the first, never the second. Do not copy a sample verbatim.",
  "brandKit.ownerNotes are the owner's own instructions and take priority over general style advice.",
] as const;

export function withBrandKitRules(systemPrompt: string, kit: BrandKitPromptContext | null | undefined): string {
  if (!kit) return systemPrompt;
  return `${systemPrompt}

BRAND KIT
${BRAND_KIT_RULES.map((rule) => `- ${rule}`).join("\n")}`;
}
