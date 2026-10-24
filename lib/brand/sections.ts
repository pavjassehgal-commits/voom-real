/**
 * Brand Hub sections (Brand Kit v2, slice 2).
 *
 * Each section owns a fixed list of brand-kit answer keys and, for the core
 * fields today's planner still reads from `businesses`, the matching columns.
 * A save validates ONLY its own section's values and never touches another
 * section's fields: the version rule in `versions.ts` carries everything else
 * forward. Pure and dependency-light so the Node suite tests it directly.
 */
import { z } from "zod";

export const BRAND_SECTION_IDS = ["basics", "brief", "offerings", "audience", "voice", "avoid", "facts", "operate"] as const;
export type BrandSectionId = (typeof BRAND_SECTION_IDS)[number];

/** The six "What you DON'T want" cards from the design. */
export const AVOID_RULES = [
  "Not salesy",
  "No \"buy now\" or discount shouting",
  "No stock-photo people",
  "No AI-looking faces",
  "No meme or trend-chasing",
  "No invented or unprovable claims",
] as const;

export interface BrandSectionMeta {
  id: BrandSectionId;
  title: string;
  intro: string;
  /** Answer keys this section replaces on save. */
  ownsKeys: readonly string[];
  /** `businesses` columns this section also writes (dual write). */
  businessColumns: readonly string[];
  /** Hidden in onboarding mode (screen 10a shows the brand itself, not operations). */
  hubOnly?: boolean;
}

export const BRAND_SECTIONS: readonly BrandSectionMeta[] = [
  { id: "basics", title: "The basics", intro: "Your name, what you do and the kind of business you are.", ownsKeys: ["name", "description", "category"], businessColumns: ["brand_name", "brand_description", "industry"] },
  { id: "brief", title: "Brand Brief", intro: "The short description MARA writes from. A few plain paragraphs in your own words.", ownsKeys: ["brief"], businessColumns: [] },
  { id: "offerings", title: "What we offer", intro: "The products or services MARA may talk about.", ownsKeys: ["offerings"], businessColumns: [] },
  { id: "audience", title: "Who we're for", intro: "Who you serve and what you want more of.", ownsKeys: ["audience", "goal"], businessColumns: ["target_customer", "main_goal"] },
  { id: "voice", title: "How we sound", intro: "Your personality, plus captions that sound like you and captions that don't.", ownsKeys: ["personality", "voice_samples"], businessColumns: ["brand_personality"] },
  { id: "avoid", title: "What we avoid", intro: "Hard rules, banned words and anything specific MARA should know.", ownsKeys: ["avoid", "notes"], businessColumns: [] },
  { id: "facts", title: "Facts MARA may state", intro: "The only specific facts (years, awards, numbers, places) MARA is allowed to say.", ownsKeys: ["facts_confirmed", "facts_unconfirmed"], businessColumns: [] },
  { id: "operate", title: "What MARA may do", intro: "How often she posts, how much she does on her own, and where.", ownsKeys: ["pace", "channels", "automation"], businessColumns: ["content_frequency", "preferred_channels", "automation_level"], hubOnly: true },
];

export function brandSectionMeta(id: BrandSectionId): BrandSectionMeta {
  const meta = BRAND_SECTIONS.find((section) => section.id === id);
  if (!meta) throw new Error(`unknown_brand_section:${id}`);
  return meta;
}

const lines = (maxItems: number, maxLen: number) => z.array(z.string()).transform((items) =>
  [...new Set(items.map((item) => item.trim().slice(0, maxLen)).filter(Boolean))].slice(0, maxItems),
);

const SCHEMAS = {
  basics: z.object({
    name: z.string().trim().max(160).default(""),
    description: z.string().trim().max(2000).default(""),
    category: z.string().trim().max(120).default(""),
  }).strict(),
  brief: z.object({ brief: z.string().trim().max(6000).default("") }).strict(),
  offerings: z.object({ offerings: lines(20, 200) }).strict(),
  audience: z.object({ audience: lines(10, 80), goal: z.string().trim().max(120).default("") }).strict(),
  voice: z.object({ personality: lines(10, 40), liked: lines(5, 600), disliked: lines(5, 600) }).strict(),
  avoid: z.object({ rules: lines(20, 200), words: lines(50, 60), notes: z.string().trim().max(800).default("") }).strict(),
  /** `unconfirmed`: facts MARA found in the description that the owner has not confirmed (slice 4). Never read by generation. */
  facts: z.object({ facts: lines(20, 200), unconfirmed: lines(20, 200).default([]) }).strict(),
  operate: z.object({
    pace: z.string().trim().max(80).default(""),
    channels: lines(10, 40),
    automation: z.enum(["manual", "assisted", "autopilot"]).optional(),
  }).strict(),
} as const;

export type BrandSectionValues = { [K in BrandSectionId]: z.infer<(typeof SCHEMAS)[K]> };

export type ValidatedSection =
  | {
      ok: true;
      id: BrandSectionId;
      /** Answer keys to replace in the next kit version. */
      answers: Record<string, unknown>;
      /** Present only for the brief section (undefined = keep the previous brief). */
      brief?: string;
      /** `businesses` columns to update (dual write); empty for kit-only sections. */
      business: Record<string, unknown>;
      /** The cleaned values, for the client to show after saving. */
      values: BrandSectionValues[BrandSectionId];
    }
  | { ok: false; error: string };

/** Validates one section's values and maps them to kit answers and businesses columns. */
export function validateBrandSection(id: unknown, raw: unknown): ValidatedSection {
  if (typeof id !== "string" || !(BRAND_SECTION_IDS as readonly string[]).includes(id)) {
    return { ok: false, error: "That section does not exist." };
  }
  const sectionId = id as BrandSectionId;
  const parsed = SCHEMAS[sectionId].safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, error: "Some of those values are not valid. Shorten or remove them and try again." };
  const values = parsed.data as BrandSectionValues[typeof sectionId];

  switch (sectionId) {
    case "basics": {
      const v = values as BrandSectionValues["basics"];
      return {
        ok: true, id: sectionId, values,
        answers: { name: v.name, description: v.description, category: v.category },
        business: { brand_name: v.name || null, brand_description: v.description || null, industry: v.category || null },
      };
    }
    case "brief": {
      const v = values as BrandSectionValues["brief"];
      return { ok: true, id: sectionId, values, answers: {}, brief: v.brief, business: {} };
    }
    case "offerings": {
      const v = values as BrandSectionValues["offerings"];
      return { ok: true, id: sectionId, values, answers: { offerings: v.offerings }, business: {} };
    }
    case "audience": {
      const v = values as BrandSectionValues["audience"];
      return {
        ok: true, id: sectionId, values,
        answers: { audience: v.audience, goal: v.goal },
        business: { target_customer: v.audience, main_goal: v.goal || null },
      };
    }
    case "voice": {
      const v = values as BrandSectionValues["voice"];
      return {
        ok: true, id: sectionId, values,
        answers: { personality: v.personality, voice_samples: { liked: v.liked, disliked: v.disliked } },
        business: { brand_personality: v.personality },
      };
    }
    case "avoid": {
      const v = values as BrandSectionValues["avoid"];
      return { ok: true, id: sectionId, values, answers: { avoid: { rules: v.rules, words: v.words }, notes: v.notes }, business: {} };
    }
    case "facts": {
      const v = values as BrandSectionValues["facts"];
      // A fact cannot be both confirmed and waiting for confirmation.
      const unconfirmed = v.unconfirmed.filter((fact) => !v.facts.includes(fact));
      const cleaned = { facts: v.facts, unconfirmed };
      return { ok: true, id: sectionId, values: cleaned, answers: { facts_confirmed: v.facts, facts_unconfirmed: unconfirmed }, business: {} };
    }
    case "operate": {
      const v = values as BrandSectionValues["operate"];
      const answers: Record<string, unknown> = { pace: v.pace, channels: v.channels };
      const business: Record<string, unknown> = { content_frequency: v.pace || null, preferred_channels: v.channels };
      if (v.automation) {
        answers.automation = v.automation;
        business.automation_level = v.automation;
      }
      return { ok: true, id: sectionId, values, answers, business };
    }
  }
}

/** One kit version as the hub needs it. */
export interface BrandKitVersionView {
  version: number;
  answers: Record<string, unknown>;
  brief: string;
  source: string;
  changeSummary: string;
  changedKeys: string[];
  createdAt: string;
}

/** The core `businesses` columns the hub falls back to when the kit lacks a value. */
export interface BrandBusinessCore {
  brand_name?: string | null;
  brand_description?: string | null;
  industry?: string | null;
  target_customer?: unknown;
  main_goal?: string | null;
  brand_personality?: unknown;
  preferred_channels?: unknown;
  content_frequency?: string | null;
  automation_level?: string | null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function list(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item ?? "").trim()).filter(Boolean) : [];
}
function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Builds every section's current values from the newest kit, falling back to
 * the `businesses` row for the core fields (accounts from before Brand Kit v2
 * have a business row and no kit, and must see their real values).
 */
export function brandHubValues(business: BrandBusinessCore | null, kit: Pick<BrandKitVersionView, "answers" | "brief"> | null): BrandSectionValues {
  const a = kit?.answers ?? {};
  const has = (key: string) => key in a && a[key] !== undefined && a[key] !== null;
  const avoid = obj(a.avoid);
  const voice = obj(a.voice_samples);
  const automationRaw = has("automation") ? str(a.automation) : str(business?.automation_level);
  const automation = automationRaw === "manual" || automationRaw === "assisted" || automationRaw === "autopilot" ? automationRaw : undefined;
  return {
    basics: {
      name: has("name") ? str(a.name) : str(business?.brand_name),
      description: has("description") ? str(a.description) : str(business?.brand_description),
      category: has("category") ? str(a.category) : str(business?.industry),
    },
    brief: { brief: kit?.brief ?? "" },
    offerings: { offerings: list(a.offerings) },
    audience: {
      audience: has("audience") ? list(a.audience) : list(business?.target_customer),
      goal: has("goal") ? str(a.goal) : str(business?.main_goal),
    },
    voice: {
      personality: has("personality") ? list(a.personality) : list(business?.brand_personality),
      liked: list(voice.liked),
      disliked: list(voice.disliked),
    },
    avoid: { rules: list(avoid.rules), words: list(avoid.words), notes: str(a.notes) },
    facts: { facts: list(a.facts_confirmed), unconfirmed: list(a.facts_unconfirmed) },
    operate: {
      pace: has("pace") ? str(a.pace) : str(business?.content_frequency),
      channels: has("channels") ? list(a.channels) : list(business?.preferred_channels),
      ...(automation ? { automation } : {}),
    },
  };
}

/** Plain-language labels for history lines ("Audience changed"). */
export const ANSWER_KEY_LABELS: Record<string, string> = {
  name: "Name",
  description: "Description",
  category: "Category",
  brief: "Brand Brief",
  offerings: "What we offer",
  audience: "Audience",
  goal: "Main goal",
  personality: "Personality",
  voice_samples: "Voice samples",
  avoid: "What we avoid",
  notes: "Notes for MARA",
  facts_confirmed: "Facts",
  facts_unconfirmed: "Facts needing confirmation",
  provenance: "Where answers came from",
  pace: "Posting pace",
  channels: "Channels",
  automation: "Automation level",
  budget: "Budget",
  publishing_permission: "Publishing permission",
};

export function answerKeyLabel(key: string): string {
  return ANSWER_KEY_LABELS[key] ?? key.replace(/_/g, " ");
}
