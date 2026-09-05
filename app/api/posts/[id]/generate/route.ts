import { randomUUID } from "node:crypto";
import { createAiProvider, AiError } from "@/lib/ai";
import { createMediaProvider, getMediaConfig, MediaError } from "@/lib/media";
import { getCurrentUser } from "@/lib/voom/server-data";
import { composePostCaption } from "@/lib/post/core";
import { buildPostContextPayload, POST_COPY_SYSTEM_PROMPT, postDraftSchema } from "@/lib/post/prompt";
import { getPostDraft, loadPostBrandContext, loadPostPlanContext, putPostAsset, removePostAssetObject } from "@/lib/post/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 300;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GENERATED_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/**
 * "Create with MARA" for an Instagram Post.
 *
 * MARA writes the concept, caption, CTA and hashtags from the brand profile and
 * the active marketing plan, then the visual is produced through the existing
 * media provider abstraction and stored privately in Voom storage. The post is
 * only ever marked ready AFTER the upload succeeds — a post can never claim a
 * visual Voom does not own. Nothing here is published anywhere.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return Response.json({ error: "That post was not found." }, { status: 404 });

  let brief = "";
  try {
    const body = await request.json() as { brief?: unknown };
    if (typeof body.brief === "string") brief = body.brief.trim().slice(0, 800);
  } catch { /* an empty body is fine */ }

  const admin = createAdminClient();
  const post = await getPostDraft(admin, user.id, id);
  if (!post) return Response.json({ error: "That post was not found." }, { status: 404 });
  if (post.kind !== "instagram_post") {
    return Response.json({ error: "MARA generates post visuals for Instagram Posts. Use the Reel workflow for Reels." }, { status: 400 });
  }

  const since = new Date(Date.now() - 60_000).toISOString();
  const { count } = await admin.from("mara_media_generations")
    .select("id", { count: "exact", head: true }).eq("owner_user_id", user.id)
    .gte("updated_at", since).in("status", ["processing", "completed"]);
  if ((count ?? 0) >= 4) return Response.json({ error: "MARA is generating visuals too quickly. Wait a minute and retry." }, { status: 429 });

  const [brand, plan] = await Promise.all([loadPostBrandContext(admin, user.id), loadPostPlanContext(admin, user.id)]);
  if (!brand) return Response.json({ error: "Complete your brand profile before creating posts with MARA." }, { status: 409 });

  // 1) Copy first. Text-only: no media bytes are ever sent to the provider.
  let copy;
  try {
    copy = await createAiProvider().structured({
      messages: [
        { role: "system", content: POST_COPY_SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(buildPostContextPayload({ brand, plan, format: post.format, kind: "instagram_post", brief })) },
      ],
      temperature: 0.6,
      maxTokens: 1200,
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

  // 2) Then the visual, through the existing provider abstraction. The format
  // is read from the draft, so generating cannot change the user's choice.
  const format = post.format;
  const generationId = randomUUID();
  const { error: queuedError } = await admin.from("mara_media_generations").insert({
    id: generationId,
    owner_user_id: user.id,
    conversation_id: post.conversationId,
    draft_id: id,
    media_type: "image",
    prompt: copy.visualPrompt.slice(0, 4000),
    aspect_ratio: format,
    status: "processing",
    idempotency_key: `post-studio:${id}:${generationId}`,
  });
  if (queuedError) return Response.json({ error: "Voom couldn't start that generation safely. Nothing changed." }, { status: 503 });

  try {
    const config = getMediaConfig();
    const result = await createMediaProvider(config).generateImage({ prompt: copy.visualPrompt, aspectRatio: format });
    if (!result.bytes.length || result.bytes.length > GENERATED_IMAGE_MAX_BYTES) throw new MediaError("malformed_response");

    // The bytes are stored BEFORE the post is allowed to show a visual.
    const extension = result.mimeType === "video/mp4" ? "mp4" : result.mimeType.split("/")[1] ?? "png";
    const { storagePath, previousStoragePath } = await putPostAsset(admin, user.id, id, {
      bytes: result.bytes,
      mimeType: result.mimeType,
      extension,
      displayName: `MARA visual · ${copy.concept.slice(0, 60)}`,
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
    const updated = await getPostDraft(admin, user.id, id);
    return Response.json({
      post: updated,
      message: "MARA wrote the copy and generated the visual. It is stored privately in Voom. Nothing was published.",
    });
  } catch (reason) {
    const code = reason instanceof MediaError ? reason.code : "unavailable";
    await admin.from("mara_media_generations").update({ status: "failed", error_code: code })
      .eq("id", generationId).eq("owner_user_id", user.id);
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


