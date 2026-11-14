import { getCurrentUser } from "@/lib/voom/server-data";
import { AiError, createAiProvider, createAiVisionProvider } from "@/lib/ai";
import { postAssetKindForMime } from "@/lib/post/core";
import { withBrandKitRules } from "@/lib/brand/context";
import { downscaleForVision } from "@/lib/brand/image";
import {
  buildExistingContentPayload, EXISTING_CONTENT_DISCLOSURE, EXISTING_CONTENT_SEEN_DISCLOSURE,
  POST_SUGGESTION_SEEN_SYSTEM_PROMPT, POST_SUGGESTION_SYSTEM_PROMPT, postSuggestionJsonSchema, postSuggestionSchema,
  type PostBrandContext,
} from "@/lib/post/prompt";
import { getPostDraft, loadPostBrandContext, loadPostPlanContext, readPostAssetObject } from "@/lib/post/server-data";
import { describePostImage, postVisionHint } from "@/lib/post/vision";
import { createAdminClient } from "@/utils/supabase/admin";
import { consumeAiRateLimit, rateLimitedResponse } from "@/lib/rate-limit";
import { randomUUID } from "node:crypto";

export const runtime = "nodejs";
// AI calls / sequential provider sends can exceed the platform default timeout.
export const maxDuration = 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Caption / CTA / timing suggestions for imported existing content.
 *
 * For a photo, when the optional vision model is configured (slice 5b), MARA
 * first looks at a small copy of it with a short brand hint, and the text
 * model writes for that reading, which is returned so the owner can check it.
 * The owner's "What is this post for?" line (the request body's `brief`, or
 * the draft's saved one) is the purpose the caption serves.
 * For a video, when vision is off, or when the look fails, only the file's
 * metadata plus the brand and plan context reach the text model, and the
 * response says so explicitly so the UI can never imply MARA saw the media.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  if (!(await consumeAiRateLimit(user.id, "post_suggest"))) return rateLimitedResponse();
  const { id } = await params;
  if (!UUID_RE.test(id)) return Response.json({ error: "That post was not found." }, { status: 404 });

  // "What is this post for?" as typed right now (may be unsaved); the draft's saved line otherwise.
  let typedBrief: string | null = null;
  try {
    const body = (await request.json()) as { brief?: unknown } | null;
    if (body && typeof body.brief === "string") typedBrief = body.brief.trim().slice(0, 800);
  } catch { /* no body: fall back to the saved brief */ }

  const admin = createAdminClient();
  const post = await getPostDraft(admin, user.id, id);
  if (!post) return Response.json({ error: "That post was not found." }, { status: 404 });
  const brief = typedBrief ?? post.mediaBrief ?? "";
  if (post.kind === "story") {
    // Instagram does not support captions on Stories, so there is no caption
    // copy for MARA to suggest for one.
    return Response.json({ error: "Instagram Stories don't support captions, so there is nothing for MARA to suggest." }, { status: 400 });
  }
  if (!post.visual) return Response.json({ error: "Import an image or video before asking MARA for suggestions." }, { status: 409 });

  const assetKind = postAssetKindForMime(post.visual.mimeType);
  if (!assetKind) return Response.json({ error: "That file type is not supported." }, { status: 400 });

  const [brand, plan] = await Promise.all([loadPostBrandContext(admin, user.id), loadPostPlanContext(admin, user.id)]);
  if (!brand) return Response.json({ error: "Complete your brand profile before asking MARA for suggestions." }, { status: 409 });

  const seen = assetKind === "image" ? await lookAtPostImage(admin, user.id, id, brand) : null;

  try {
    const suggestion = await createAiProvider().structured({
      messages: [
        { role: "system", content: withBrandKitRules(seen ? POST_SUGGESTION_SEEN_SYSTEM_PROMPT : POST_SUGGESTION_SYSTEM_PROMPT, brand.brandKit) },
        {
          role: "user",
          content: JSON.stringify(buildExistingContentPayload({
            displayName: post.visual.displayName,
            mimeType: post.visual.mimeType,
            byteSize: post.visual.byteSize,
            assetKind,
            brand,
            plan,
            nowIso: new Date().toISOString(),
            visual: seen ? { description: seen } : null,
            brief,
          })),
        },
      ],
      temperature: 0.5,
      maxTokens: 900,
      usage: {
        ownerId: user.id,
        operationKey: `post-suggest:${id}:${randomUUID()}`,
        operationType: "post_caption_suggestion",
        category: "caption",
      },
      // Groq json_schema structured output (strict where supported); the zod
      // parse stays the second safety layer before any suggestion is returned.
      jsonSchema: postSuggestionJsonSchema,
      parse: (value) => postSuggestionSchema.parse(value),
    });

    let suggestedPublishAt: string | null = null;
    if (suggestion.suggestedPublishAt && !Number.isNaN(Date.parse(suggestion.suggestedPublishAt))) {
      const parsed = new Date(suggestion.suggestedPublishAt);
      // Only a genuinely future slot is offered; otherwise leave it unscheduled.
      if (parsed.getTime() > Date.now()) suggestedPublishAt = parsed.toISOString();
    }

    return Response.json({
      suggestion: {
        caption: suggestion.caption,
        cta: suggestion.cta,
        hashtags: suggestion.hashtags,
        suggestedPublishAt,
        timingReason: suggestion.timingReason,
      },
      inspectedVisual: Boolean(seen),
      disclosure: seen ? EXISTING_CONTENT_SEEN_DISCLOSURE : EXISTING_CONTENT_DISCLOSURE,
      ...(seen ? { visualDescription: seen } : {}),
    });
  } catch (reason) {
    if (reason instanceof AiError && reason.code === "not_configured") {
      return Response.json({ error: "MARA's AI provider is not configured yet, so no suggestions were generated." }, { status: 503 });
    }
    if (reason instanceof AiError && reason.code === "rate_limited") {
      return Response.json({ error: "MARA is busy right now. Wait a moment and retry." }, { status: 429 });
    }
    return Response.json({ error: "MARA couldn't suggest copy just now. Please retry." }, { status: 502 });
  }
}

/**
 * One look at the stored photo. Null, and the unseen path, whenever the vision
 * model is not configured (nothing spent), the hourly bucket is used up, the
 * file cannot be read, or the call fails: a suggestion is still written.
 */
async function lookAtPostImage(admin: ReturnType<typeof createAdminClient>, ownerId: string, draftId: string, brand: PostBrandContext): Promise<string | null> {
  let provider: ReturnType<typeof createAiVisionProvider>;
  try { provider = createAiVisionProvider(); } catch { return null; }
  if (!(await consumeAiRateLimit(ownerId, "post_vision"))) return null;
  try {
    const bytes = await readPostAssetObject(admin, ownerId, draftId);
    if (!bytes) return null;
    const jpeg = await downscaleForVision(bytes);
    const description = await describePostImage(provider, { jpeg, hint: postVisionHint(brand) });
    return description || null;
  } catch (error) {
    // The message carries the provider's HTTP status or stage, never a key or the image.
    console.error("[post-vision] failed", { code: error instanceof AiError ? error.code : "unknown", message: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
