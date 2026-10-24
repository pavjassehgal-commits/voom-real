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
import { extractBrandFromDescription, type BrandLearned } from "./extract";

export type ExtractBrandReason = "login" | "too_short" | "rate_limited" | "not_configured" | "unavailable";

export type ExtractBrandResult =
  | { ok: true; learned: BrandLearned }
  | { ok: false; reason: ExtractBrandReason };

export async function extractBrandDescription(description: unknown): Promise<ExtractBrandResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, reason: "login" };

  const text = typeof description === "string" ? description.trim() : "";
  if (text.split(/\s+/).filter(Boolean).length < 5) return { ok: false, reason: "too_short" };

  if (!(await consumeAiRateLimit(user.id, "brand_extract"))) return { ok: false, reason: "rate_limited" };

  try {
    const learned = await extractBrandFromDescription(createAiProvider(), text);
    return { ok: true, learned };
  } catch (error) {
    const code = error instanceof AiError ? error.code : "unknown";
    console.error("[brand-extract] failed", { code });
    if (code === "not_configured") return { ok: false, reason: "not_configured" };
    if (code === "rate_limited") return { ok: false, reason: "rate_limited" };
    return { ok: false, reason: "unavailable" };
  }
}
