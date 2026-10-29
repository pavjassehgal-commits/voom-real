"use server";

/**
 * Brand Kit v2, slice 7: the two server actions behind "Give MARA your
 * brand"'s website field, started side by side by the wizard:
 *
 *   - `readBrandWebsiteText`: the site's text (lib/brand/website-fetch.ts),
 *     about 3 s, which the reading screen waits for;
 *   - `readBrandWebsiteLook`: one homepage screenshot to the vision model
 *     (lib/brand/website-screenshot.ts + lib/brand/website.ts), about 10 s,
 *     which lands in the background.
 *
 * Logged-in users only, 10 reads per user per hour each. Every failure is a
 * plain reason, never a thrown error. Nothing is stored here: the wizard
 * keeps the result until Finish records a small summary with the kit.
 */
import { AiError, createAiProvider, createAiVisionProvider } from "@/lib/ai";
import { getCurrentUser } from "@/lib/voom/server-data";
import { consumeAiRateLimit } from "@/lib/rate-limit";
import { downscaleForVision } from "./image";
import { checkWebsiteUrl, describeWebsiteLook, draftDescriptionFromWebsite, WEBSITE_READ_LIMITS, type WebsiteLook, type WebsiteReadStatus } from "./website";
import { readWebsite } from "./website-fetch";
import { screenshotWebsite } from "./website-screenshot";

export type WebsiteReadReason = "login" | "rate_limited" | Exclude<WebsiteReadStatus, "ready">;

export type WebsiteTextResult =
  | {
      ok: true;
      url: string;
      finalUrl: string;
      fetchedAt: string;
      /** The capped block for MARA's extraction. */
      text: string;
      pageTitles: string[];
      /** MARA's draft of the description from the site ("" when the text model is off, failed, or found nothing to say). */
      descriptionDraft: string;
      draftStatus: "ready" | "off" | "failed" | "empty";
    }
  | { ok: false; reason: WebsiteReadReason };

export type WebsiteLookResult =
  | { ok: true; url: string; look: WebsiteLook }
  | { ok: false; reason: "login" | "rate_limited" | "refused" | "off" | "failed" };

export async function readBrandWebsiteText(raw: unknown): Promise<WebsiteTextResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, reason: "login" };
  const check = checkWebsiteUrl(typeof raw === "string" ? raw : "");
  if (!check.ok) return { ok: false, reason: "refused" };
  if (!(await consumeAiRateLimit(user.id, "brand_website"))) return { ok: false, reason: "rate_limited" };

  const snapshot = await readWebsite(check.url.href);
  if (snapshot.status !== "ready") {
    console.log("[brand-website] text", { status: snapshot.status });
    return { ok: false, reason: snapshot.status };
  }
  const text = snapshot.text.slice(0, WEBSITE_READ_LIMITS.totalChars);
  const draft = await draftDescription({ url: snapshot.finalUrl, text });
  console.log("[brand-website] text", { status: snapshot.status, pages: snapshot.pages.length, chars: text.length, draft: draft.draftStatus });
  return {
    ok: true,
    url: snapshot.url,
    finalUrl: snapshot.finalUrl,
    fetchedAt: snapshot.fetchedAt,
    text,
    pageTitles: snapshot.pages.map((page) => page.title).filter(Boolean).slice(0, WEBSITE_READ_LIMITS.pages),
    descriptionDraft: draft.descriptionDraft,
    draftStatus: draft.draftStatus,
  };
}

/** MARA's draft of the description from the site's text: "off" without a text model, "failed" when the call failed, "empty" when she found nothing to say. */
async function draftDescription(website: { url: string; text: string }): Promise<{ descriptionDraft: string; draftStatus: "ready" | "off" | "failed" | "empty" }> {
  let provider: ReturnType<typeof createAiProvider>;
  try { provider = createAiProvider(); } catch { return { descriptionDraft: "", draftStatus: "off" }; }
  try {
    const descriptionDraft = await draftDescriptionFromWebsite(provider, website);
    return descriptionDraft ? { descriptionDraft, draftStatus: "ready" } : { descriptionDraft: "", draftStatus: "empty" };
  } catch (error) {
    console.error("[brand-website] draft failed", { code: error instanceof AiError ? error.code : "unknown", message: error instanceof Error ? error.message : String(error) });
    return { descriptionDraft: "", draftStatus: "failed" };
  }
}

/** The screenshot plus vision call. "off" without a vision model (nothing spent), "failed" when either step failed. */
export async function readBrandWebsiteLook(raw: unknown): Promise<WebsiteLookResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, reason: "login" };
  const check = checkWebsiteUrl(typeof raw === "string" ? raw : "");
  if (!check.ok) return { ok: false, reason: "refused" };
  let provider: ReturnType<typeof createAiVisionProvider>;
  try { provider = createAiVisionProvider(); } catch { return { ok: false, reason: "off" }; }
  if (!(await consumeAiRateLimit(user.id, "brand_website_look"))) return { ok: false, reason: "rate_limited" };
  try {
    const shot = await screenshotWebsite(check.url.href);
    if (!shot) return { ok: false, reason: "failed" };
    const jpeg = await downscaleForVision(shot);
    const look = await describeWebsiteLook(provider, jpeg);
    console.log("[brand-website] look", { colours: [look.primary, look.secondary].filter(Boolean).length, tags: look.styleTags.length });
    return { ok: true, url: check.url.href, look };
  } catch (error) {
    // The message carries the provider's HTTP status or stage, never a key or the image.
    console.error("[brand-website] look failed", { code: error instanceof AiError ? error.code : "unknown", message: error instanceof Error ? error.message : String(error) });
    return { ok: false, reason: "failed" };
  }
}
