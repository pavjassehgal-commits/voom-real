import { randomUUID } from "node:crypto";
import { createAiProvider, AiError } from "@/lib/ai";
import { createMediaProvider, getMediaConfig, MediaError } from "@/lib/media";
import { getCurrentUser } from "@/lib/voom/server-data";
import { composePostCaption } from "@/lib/post/core";
import { buildPostContextPayload, POST_COPY_SYSTEM_PROMPT, postDraftJsonSchema, postDraftSchema, STORY_VISUAL_SYSTEM_PROMPT, storyVisualJsonSchema, storyVisualSchema } from "@/lib/post/prompt";
import { getPostDraft, loadPostBrandContext, loadPostPlanContext, normalizeMediaBrief, putPostAsset, removePostAssetObject, syncPostToCalendar } from "@/lib/post/server-data";
import { startPostStudioVideo } from "@/lib/mara/video-service";
import { estimateMediaCostUsd, normalizeAllowAutomaticPaidMedia } from "@/lib/mara/media-spend";
import { aspectMatches, inspectImageBytes } from "@/lib/media/media-inspect";
import { applyPostOverlay } from "@/lib/media/image-overlay";
import { createAdminClient } from "@/utils/supabase/admin";
import { normalizePlan, canUseAutomationMode } from "@/lib/billing/plans";
import { creditCostForMedia } from "@/lib/billing/credits";
import { guardAndReserveMedia, releaseReservationOnFailure, confirmReservation } from "@/lib/billing/entitlement-guard";

export const runtime = "nodejs";
export const maxDuration = 300;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GENERATED_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/**
 * "Create with MARA" for an Instagram Post, Reel or Story — now with Voom credit reservation.
 *
 * Before any provider call:
 * 1. calculate required Voom credits
 * 2. verify plan entitlement (Free has no AI generation)
 * 3. verify enough credits remain
 * 4. atomically reserve/deduct credits
 * 5. only then submit provider job
 * If provider fails before real paid job, refund reservation.
 */

async function loadBillingContext(admin: any, ownerId: string) {
  try {
    const { data } = await admin.from("businesses").select("plan,allow_automatic_paid_media,automation_level").eq("owner_user_id", ownerId).maybeSingle();

    const plan = normalizePlan((data as any)?.plan);
    const allowAutomatic = normalizeAllowAutomaticPaidMedia((data as any)?.allow_automatic_paid_media);
    let mode = (data as any)?.automation_level === "manual" || (data as any)?.automation_level === "autopilot" ? (data as any).automation_level : "assisted";
    if (!canUseAutomationMode(plan, mode)) {
      mode = plan === "pro" ? "assisted" : "manual";
    }
    return { plan, allowAutomatic, mode };
  } catch {
    return { plan: "free" as const, allowAutomatic: false, mode: "assisted" as const };
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return Response.json({ error: "That post was not found." }, { status: 404 });

  let briefInput: string | null | undefined;
  let wantsVideo = false;
  let idempotencyToken: string = randomUUID();
  try {
    const body = await request.json() as { brief?: unknown; media?: unknown; idempotencyKey?: unknown };
    if (typeof body.brief === "string") {
      const trimmed = body.brief.trim();
      briefInput = trimmed ? trimmed.slice(0, 800) : null;
    }
    wantsVideo = body.media === "video";
    if (typeof body.idempotencyKey === "string" && body.idempotencyKey.trim()) idempotencyToken = body.idempotencyKey.trim();
  } catch { /* an empty body is fine */ }

  const admin = createAdminClient();
  const post = await getPostDraft(admin, user.id, id);
  if (!post) return Response.json({ error: "That post was not found." }, { status: 404 });

  let effectiveBrief = "";
  if (briefInput !== undefined) {
    effectiveBrief = briefInput ?? "";
    const normalized = normalizeMediaBrief(briefInput);
    await admin.from("mara_drafts").update({ media_brief: normalized }).eq("owner_user_id", user.id).eq("id", id);
  } else {
    effectiveBrief = post.mediaBrief ?? "";
  }

  const billing = await loadBillingContext(admin, user.id);

  if (wantsVideo) {
    if (post.kind !== "reel" && post.kind !== "story") {
      return Response.json({ error: "MARA generates video for Reels and Stories. Use the Post flow for feed images." }, { status: 400 });
    }
    // Video path reserves credits inside video-ports → guardAndReserveMedia BEFORE provider submit.
    // We pass a stable generationId so ledger id == mara row id for traceability.
    const generationIdForLedger = randomUUID();
    const result = await startPostStudioVideo({
      admin,
      ownerId: user.id,
      post: { id, kind: post.kind, conversationId: post.conversationId, concept: post.concept },
      brief: effectiveBrief,
      idempotencyToken,
      generationId: generationIdForLedger,
    });

    if ("error" in result) {
      return Response.json({ generation: result.generation, error: result.error }, { status: result.status });
    }

    return Response.json(
      { generation: result.generation, post: await getPostDraft(admin, user.id, id), message: result.message },
      { status: result.status },
    );
  }

  if (post.kind !== "instagram_post" && post.kind !== "story") {
    return Response.json({ error: "MARA generates visuals for Instagram Posts and Stories. Use the Reel workflow for Reels." }, { status: 400 });
  }

  const since = new Date(Date.now() - 60_000).toISOString();
  const { count } = await admin.from("mara_media_generations")
    .select("id", { count: "exact", head: true }).eq("owner_user_id", user.id)
    .gte("updated_at", since).in("status", ["processing", "completed"]);
  if ((count ?? 0) >= 4) return Response.json({ error: "MARA is generating visuals too quickly. Wait a minute and retry." }, { status: 429 });

  const [brand, planContext] = await Promise.all([loadPostBrandContext(admin, user.id), loadPostPlanContext(admin, user.id)]);
  if (!brand) return Response.json({ error: "Complete your brand profile before creating posts with MARA." }, { status: 409 });

  let concept: string;
  let visualPrompt: string;
  let overlayCta = "";
  if (post.kind === "story") {
    let storyPlan;
    try {
      storyPlan = await createAiProvider().structured({
        messages: [
          { role: "system", content: STORY_VISUAL_SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(buildPostContextPayload({ brand, plan: planContext, format: "9:16", kind: "story", brief: effectiveBrief })) },
        ],
        temperature: 0.6,
        maxTokens: 600,
        jsonSchema: storyVisualJsonSchema,
        parse: (value) => storyVisualSchema.parse(value),
      });
    } catch (reason) {
      if (reason instanceof AiError && reason.code === "not_configured") {
        return Response.json({ error: "MARA's AI provider is not configured yet, so no Story visual was generated." }, { status: 503 });
      }
      if (reason instanceof AiError && reason.code === "rate_limited") {
        return Response.json({ error: "MARA is busy right now. Wait a moment and retry." }, { status: 429 });
      }
      return Response.json({ error: "MARA couldn't plan that Story. Please retry." }, { status: 502 });
    }
    concept = storyPlan.concept.trim().slice(0, 160);
    visualPrompt = storyPlan.visualPrompt;
    const { error: titleError } = await admin.from("mara_drafts")
      .update({ title: concept, content: concept })
      .eq("owner_user_id", user.id).eq("id", id);
    if (titleError) return Response.json({ error: "MARA planned the Story but Voom couldn't save it. Please retry." }, { status: 503 });
  } else {
    let copy;
    try {
      copy = await createAiProvider().structured({
        messages: [
          { role: "system", content: POST_COPY_SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(buildPostContextPayload({ brand, plan: planContext, format: post.format, kind: "instagram_post", brief: effectiveBrief })) },
        ],
        temperature: 0.6,
        maxTokens: 1200,
        jsonSchema: postDraftJsonSchema,
        parse: (value) => postDraftSchema.parse(value),
      });
    } catch (reason) {
      if (reason instanceof AiError && reason.code === "not_configured") {
        return Response.json({ error: "MARA's AI provider is not configured yet, so no copy was generated." }, { status: 503 });
      }
      if (reason instanceof AiError && reason.code === "rate_limited") {
        return Response.json({ error: "MARA is busy right now. Wait a moment and retry." }, { status: 429 });
      }
      return Response.json({ error: "MARA couldn't write that post. Please retry." }, { status: 502 });
    }

    const caption = composePostCaption({ caption: copy.caption, cta: copy.cta, hashtags: copy.hashtags });
    const { error: copyError } = await admin.from("mara_drafts")
      .update({ title: copy.concept.trim().slice(0, 160), content: caption.slice(0, 12000) })
      .eq("owner_user_id", user.id).eq("id", id);
    if (copyError) return Response.json({ error: "MARA wrote the copy but Voom couldn't save it. Please retry." }, { status: 503 });
    concept = copy.concept.trim().slice(0, 160);
    visualPrompt = copy.visualPrompt;
    overlayCta = copy.cta;
  }

  const format = post.kind === "story" ? "9:16" : post.format;
  const generationId = randomUUID();

  // Reserve credits BEFORE provider submission
  const requiredCredits = creditCostForMedia({ mediaType: "image" });
  const guard = await guardAndReserveMedia(admin, {
    ownerId: user.id,
    planId: billing.plan,
    mode: billing.mode,
    allowAutomaticPaidMedia: billing.allowAutomatic,
    mediaType: "image",
    source: "user_request",
    generationId,
  });

  if (!guard.allow) {
    if (guard.code === "plan_not_allowed") {
      return Response.json({
        error: guard.message,
        code: guard.code,
        creditsNeeded: guard.credits,
        upgradeRequired: true,
      }, { status: 402 });
    }
    return Response.json({
      error: guard.message,
      code: guard.code,
      creditsNeeded: guard.credits,
      remaining: 0,
    }, { status: 402 });
  }

  const { error: queuedError } = await admin.from("mara_media_generations").insert({
    id: generationId,
    owner_user_id: user.id,
    conversation_id: post.conversationId,
    draft_id: id,
    media_type: "image",
    prompt: visualPrompt.slice(0, 4000),
    aspect_ratio: format,
    status: "processing",
    idempotency_key: `post-studio:${id}:${generationId}`,
    spend_source: "user_request",
    estimated_cost_usd: estimateMediaCostUsd({ mediaType: "image" }),
  });
  if (queuedError) {
    await releaseReservationOnFailure(admin, user.id, generationId).catch(() => null);
    return Response.json({ error: "Voom couldn't start that generation safely. Nothing changed." }, { status: 503 });
  }

  try {
    const config = getMediaConfig();
    const result = await createMediaProvider(config).generateImage({ prompt: visualPrompt, aspectRatio: format });
    if (!result.bytes.length || result.bytes.length > GENERATED_IMAGE_MAX_BYTES) throw new MediaError("malformed_response");

    const inspected = inspectImageBytes(result.bytes);
    if (!inspected || !aspectMatches(inspected.width, inspected.height, format)) throw new MediaError("malformed_response");
    result.mimeType = inspected.mimeType;

    if (post.kind === "instagram_post" && overlayCta.trim()) {
      try {
        const overlaid = await applyPostOverlay({ bytes: result.bytes, mimeType: result.mimeType }, { brandName: brand.brandName, cta: overlayCta });
        result.bytes = overlaid.bytes;
        result.mimeType = overlaid.mimeType;
      } catch { /* keep the valid base media */ }
    }

    const extension = result.mimeType === "image/png" ? "png" : result.mimeType === "image/webp" ? "webp" : "jpg";
    const { storagePath, previousStoragePath } = await putPostAsset(admin, user.id, id, {
      bytes: result.bytes,
      mimeType: result.mimeType,
      extension,
      displayName: `MARA visual · ${concept.slice(0, 60)}`,
      origin: "mara",
    });

    await admin.from("mara_media_generations").update({
      provider: config.provider,
      storage_path: storagePath,
      mime_type: result.mimeType,
      byte_size: result.bytes.length,
      status: "completed",
      completed_at: new Date().toISOString(),
      error_code: null,
    }).eq("id", generationId).eq("owner_user_id", user.id);

    if (previousStoragePath && previousStoragePath !== storagePath) {
      await removePostAssetObject(admin, user.id, previousStoragePath);
    }
    await confirmReservation(admin, user.id, generationId).catch(() => null);
    await syncPostToCalendar(admin, user.id, id).catch(() => null);
    const updated = await getPostDraft(admin, user.id, id);
    return Response.json({
      post: updated,
      message: "MARA wrote the copy and generated the visual. It is stored privately in Voom. Nothing was published.",
    });
  } catch (reason) {
    const code = reason instanceof MediaError ? reason.code : "unavailable";
    await admin.from("mara_media_generations").update({ status: "failed", error_code: code, provider_diagnostic: reason instanceof MediaError ? reason.diagnostic : null })
      .eq("id", generationId).eq("owner_user_id", user.id);
    await releaseReservationOnFailure(admin, user.id, generationId).catch(() => null);
    if (code === "not_configured") {
      return Response.json({
        post: await getPostDraft(admin, user.id, id),
        error: "MARA saved the copy, but the image provider is not configured, so no visual was generated.",
      }, { status: 503 });
    }
    if (code === "rate_limited") return Response.json({ error: "The image provider is busy. Wait a moment and retry." }, { status: 429 });
    return Response.json({
      post: await getPostDraft(admin, user.id, id),
      error: "MARA saved the copy, but the visual could not be generated. No visual was attached.",
    }, { status: 503 });
  }
}
