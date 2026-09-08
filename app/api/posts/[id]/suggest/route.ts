import { getCurrentUser } from "@/lib/voom/server-data";
import { AiError, createAiProvider } from "@/lib/ai";
import { postAssetKindForMime } from "@/lib/post/core";
import { buildExistingContentPayload, EXISTING_CONTENT_DISCLOSURE, POST_SUGGESTION_SYSTEM_PROMPT, postSuggestionSchema } from "@/lib/post/prompt";
import { getPostDraft, loadPostBrandContext, loadPostPlanContext } from "@/lib/post/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Caption / CTA / timing suggestions for imported existing content.
 *
 * There is no vision model in this flow. Only the file's metadata (name, type,
 * size) plus the brand and plan context reach the provider, and the response
 * says so explicitly so the UI can never imply MARA looked at the media.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return Response.json({ error: "That post was not found." }, { status: 404 });

  const admin = createAdminClient();
  const post = await getPostDraft(admin, user.id, id);
  if (!post) return Response.json({ error: "That post was not found." }, { status: 404 });
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

  try {
    const suggestion = await createAiProvider().structured({
      messages: [
        { role: "system", content: POST_SUGGESTION_SYSTEM_PROMPT },
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
          })),
        },
      ],
      temperature: 0.5,
      maxTokens: 900,
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
      inspectedVisual: false,
      disclosure: EXISTING_CONTENT_DISCLOSURE,
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
