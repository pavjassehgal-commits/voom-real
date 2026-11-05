"use server";

/**
 * "Send to MARA" (Brand Kit v2, slice 4): the server action behind the
 * "Here's what I learned" screen. Logged-in users only, one bucket in the
 * existing limiter, one structured AI call. Every failure comes back as a
 * plain reason, never a thrown error, so the wizard can fall back to the
 * keyword guess and carry on; the description is never stored here.
 */
import { AiError, createAiProvider } from "@/lib/ai";
import { getCurrentUser } from "@/lib/voom/server-data";
import { consumeAiRateLimit } from "@/lib/rate-limit";
import { z } from "zod";
import { BRAND_EXTRACTION_WEBSITE_MAX, extractBrandFromDescription, type BrandLearned } from "./extract";

export type ExtractBrandReason = "login" | "too_short" | "rate_limited" | "not_configured" | "unavailable";

export type ExtractBrandResult =
  | { ok: true; learned: BrandLearned }
  | { ok: false; reason: ExtractBrandReason };

/** Slice 7: the website text the wizard read (lib/brand/website-actions.ts), sent along with the description. */
const websiteInput = z.object({ url: z.string().trim().max(500), text: z.string().max(BRAND_EXTRACTION_WEBSITE_MAX) }).strict();

export async function extractBrandDescription(description: unknown, website: unknown = null): Promise<ExtractBrandResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, reason: "login" };

  const text = typeof description === "string" ? description.trim() : "";
  if (text.split(/\s+/).filter(Boolean).length < 5) return { ok: false, reason: "too_short" };
  const site = websiteInput.safeParse(website);

  if (!(await consumeAiRateLimit(user.id, "brand_extract"))) return { ok: false, reason: "rate_limited" };

  try {
    const learned = await extractBrandFromDescription(createAiProvider(), text, site.success && site.data.text.trim() ? site.data : null);
    return { ok: true, learned };
  } catch (error) {
    const code = error instanceof AiError ? error.code : "unknown";
    console.error("[brand-extract] failed", { code });
    if (code === "not_configured") return { ok: false, reason: "not_configured" };
    if (code === "rate_limited") return { ok: false, reason: "rate_limited" };
    return { ok: false, reason: "unavailable" };
  }
}
