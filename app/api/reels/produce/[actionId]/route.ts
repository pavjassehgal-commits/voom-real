import { getCurrentUser } from "@/lib/voom/server-data";
import { createAiProvider } from "@/lib/ai";
import { buildReelComposition, isReelComposition } from "@/lib/mara/reel-composition";
import { enforceViewerCopy, fallbackViewerCopy, viewerCopySchema, type ViewerCopyContext } from "@/lib/mara/reel-copy";
import { classifyReelProduction } from "@/lib/mara/reel-production";
import { assetKindForMime, assignReelVisuals } from "@/lib/mara/reel-visuals";
import { startPostStudioVideo, advanceVideoJob, buildVideoService, enforceVideoJobHardTimeout, latestVideoGeneration } from "@/lib/mara/video-service";
import { VIDEO_JOB_TIMEOUT_ERROR_CODE, videoJobSafeError } from "@/lib/mara/video-job";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 300;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTION_COLUMNS = "id,conversation_id,message_id,tool_name,summary,old_value,new_value,sanitized_arguments,status,result_summary,error_summary,created_at,updated_at,executed_at";

const REEL_COPY_SYSTEM_PROMPT = `You write the exact on-screen text for one short-form 9:16 social Reel. Return JSON only with exactly these keys: {"hook":"string","message":"string","value":"string","cta":"string"}.
Rules:
- hook: 3-8 words, viewer-facing, attention-grabbing.
- message: 4-10 words stating the main point plainly.
- value: 4-10 words of supporting reason grounded ONLY in the supplied concept and caption.
- cta: at most 6 words, one short action; it may end with an arrow character.
- Never output production or shot direction. Forbidden on-screen words include: opening shot, quick cuts, close-up, end frame, cut, scene, frame, camera, angle, transition, B-roll, voice-over, payoff, shot list, call to action, CTA. Never mention the internal script or shot instructions themselves.
- Never invent prices, discounts, offers, guarantees, store locations, links, or claims not present in the supplied caption/concept. Never fabricate the business identity.
- No hashtags, no URLs, no screen-reader notes, no captions like "text here". Plain concise marketing copy only.`;

/**
 * Reel production for a plan-driven Reel (Approvals).
 *
 * POST "Create with MARA":
 *   - video provider configured  -> REAL 9:16 video: MARA plans the video,
 *     generates a clean base frame (or animates the uploaded image), and a
 *     durable asynchronous provider job runs. productionStatus tracks the
 *     job; the server-side media worker polls it independently of the board.
 *     GET below may refresh the display. On success the validated MP4 becomes
 *     the draft's private asset, so the existing approval -> schedule ->
 *     publish pipeline takes over unchanged.
 *   - video provider not configured -> the previous deterministic composition
 *     flow (playable preview, no rendered video) so production degrades
 *     truthfully instead of breaking.
 *
 * Nothing here publishes anywhere.
 */
export async function POST(request: Request, { params }: { params: Promise<{ actionId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const { actionId } = await params;
  if (!UUID_RE.test(actionId)) return Response.json({ error: "That Reel request is not valid." }, { status: 400 });
  let idempotencyToken: string | null = null;
  try {
    const body = await request.json() as { idempotencyKey?: unknown };
    if (typeof body.idempotencyKey === "string" && body.idempotencyKey.trim()) idempotencyToken = body.idempotencyKey.trim();
  } catch { /* no body on the first production click */ }
  const db = await createClient();
  const { data: action } = await db.from("mara_pending_actions").select(ACTION_COLUMNS).eq("id", actionId).eq("owner_user_id", user.id).eq("tool_name", "choose_reel_production").eq("status", "pending").maybeSingle();
  if (!action || !action.new_value || typeof action.new_value.draftId !== "string") return Response.json({ error: "That Reel request was not found." }, { status: 404 });
  if (action.new_value.productionStatus === "video_generating" || action.new_value.productionStatus === "video_processing") {
    return Response.json({ action, message: "MARA is already generating this Reel video. Poll its status before starting another." }, { status: 409 });
  }
  if (isReelComposition(action.new_value.reelComposition) && action.new_value.productionStatus === "produced") return Response.json({ action, message: "This Reel is already produced and ready for review." });

  const capability = classifyReelProduction({ concept: String(action.new_value.concept ?? ""), script: String(action.new_value.script ?? ""), shotInstructions: Array.isArray(action.new_value.shotInstructions) ? action.new_value.shotInstructions.filter((shot: unknown): shot is string => typeof shot === "string") : [] });
  const assetReceived = action.new_value.assetReceived === true;
  if (!capability.availableMethods.includes("create_with_mara") && !assetReceived) return Response.json({ error: "Upload the requested real-world asset before Voom produces this Reel." }, { status: 409 });
  const admin = createAdminClient();
  const { data: assetRows } = await admin.from("reel_draft_assets").select("id,mime_type,storage_path,status,created_at").eq("owner_user_id", user.id).eq("draft_id", action.new_value.draftId).order("created_at").order("id").limit(6);
  const assetPack = (assetRows ?? []).filter((row) => typeof row.id === "string" && assetKindForMime(String(row.mime_type)) !== null);
  const usesAsset = assetPack.length > 0;
  if (assetReceived && !usesAsset) return Response.json({ error: "The required private asset could not be verified." }, { status: 409 });

  // ---- Real video production (preferred when a video provider is configured)
  const service = await buildVideoService(admin, user.id);
  if (service) {
    const sourceImage = assetPack.find((row) => String(row.mime_type) === "image/jpeg" || String(row.mime_type) === "image/png" || String(row.mime_type) === "image/webp");
    const preparing = { ...action.new_value, selectedProductionMethod: "create_with_mara", productionStatus: "video_preparing" };
    const { error: preparingError } = await db.from("mara_pending_actions").update({ new_value: preparing, sanitized_arguments: { ...(action.new_value ?? {}), selectedProductionMethod: "create_with_mara", productionStatus: "video_preparing" }, result_summary: "Preparing the live Voom Reel video." }).eq("id", actionId).eq("owner_user_id", user.id).eq("status", "pending");
    if (preparingError) return Response.json({ error: "Voom couldn't start Reel production safely." }, { status: 503 });

    const sourceAsset = sourceImage && typeof sourceImage.storage_path === "string"
      ? { storagePath: sourceImage.storage_path, assetId: typeof sourceImage.id === "string" ? sourceImage.id : null }
      : null;
    if (sourceAsset && !service.videoConfig.supportsImageToVideo) {
      const { error: failError } = await db.from("mara_pending_actions").update({ new_value: { ...preparing, productionStatus: "video_failed" }, error_summary: "This video provider can't animate your image yet. Your previous asset is unchanged.", result_summary: "Reel video production stopped safely. Nothing was published." }).eq("id", actionId).eq("owner_user_id", user.id).eq("status", "pending");
      if (failError) return Response.json({ error: "Voom couldn't update that Reel safely." }, { status: 503 });
      return Response.json({ error: "This video provider can't animate your image yet. Your previous asset is unchanged." }, { status: 503 });
    }

    const draftId = action.new_value.draftId as string;
    const { data: draft } = await db.from("mara_drafts").select("title").eq("id", draftId).eq("owner_user_id", user.id).maybeSingle();
    const result = await startPostStudioVideo({
      admin,
      ownerId: user.id,
      post: { id: draftId, kind: "reel", conversationId: String(action.conversation_id ?? ""), concept: String(action.new_value.concept ?? draft?.title ?? "Reel") },
      script: String(action.new_value.script ?? "").slice(0, 1200),
      brief: "",
      idempotencyToken: idempotencyToken ?? actionId,
      sourceAsset,
    });
    if ("error" in result) {
      if (result.status === 409 && result.generation) {
        // A concurrent click won the race and the job is running: reflect the
        // active job instead of failing the action (the board will keep
        // polling it to completion).
        const { error: syncError } = await db.from("mara_pending_actions").update({ new_value: { ...(action.new_value ?? {}), selectedProductionMethod: "create_with_mara", productionStatus: "video_generating", generationId: result.generation.id }, result_summary: "MARA is generating this Reel video. This can take a few minutes. Nothing was published.", error_summary: null }).eq("id", actionId).eq("owner_user_id", user.id).eq("status", "pending");
        if (syncError) return Response.json({ error: "Voom couldn't update that Reel safely." }, { status: 503 });
        return Response.json({ action, message: result.error }, { status: 409 });
      }
      const { error: failError } = await db.from("mara_pending_actions").update({ new_value: { ...(action.new_value ?? {}), productionStatus: "video_failed" }, error_summary: result.error, result_summary: "Reel video production stopped safely. Nothing was published." }).eq("id", actionId).eq("owner_user_id", user.id).eq("status", "pending");
      if (failError) return Response.json({ error: "Voom couldn't update that Reel safely." }, { status: 503 });
      return Response.json({ error: result.error }, { status: result.status });
    }
    const started = await db.from("mara_pending_actions").update({ new_value: { ...preparing, productionStatus: "video_generating", generationId: result.generation.id }, sanitized_arguments: { ...(action.new_value ?? {}), selectedProductionMethod: "create_with_mara", productionStatus: "video_generating", generationId: result.generation.id }, result_summary: "MARA is generating this Reel video. This can take a few minutes. Nothing was published.", error_summary: null }).eq("id", actionId).eq("owner_user_id", user.id).eq("status", "pending").select(ACTION_COLUMNS).single();
    if (started.error || !started.data) return Response.json({ error: "Voom couldn't record that generation safely. Nothing changed." }, { status: 503 });
    return Response.json({ action: started.data, message: result.message }, { status: result.status === 202 ? 202 : 200 });
  }

  // ---- Fallback: deterministic composition (previous behaviour, unchanged)
  const preparing = { ...action.new_value, selectedProductionMethod: "create_with_mara", productionStatus: "preparing" };
  const { error: preparingError } = await db.from("mara_pending_actions").update({ new_value: preparing, sanitized_arguments: { ...(action.new_value ?? {}), selectedProductionMethod: "create_with_mara", productionStatus: "preparing" }, result_summary: "Preparing the live Voom Reel composition." }).eq("id", actionId).eq("owner_user_id", user.id).eq("status", "pending");
  if (preparingError) return Response.json({ error: "Voom couldn't start Reel production safely." }, { status: 503 });

  const [{ data: draft }, { data: business }] = await Promise.all([
    db.from("mara_drafts").select("title,content").eq("id", action.new_value.draftId).eq("owner_user_id", user.id).maybeSingle(),
    db.from("businesses").select("brand_name,brand_description,industry,target_customer,main_goal").eq("owner_user_id", user.id).maybeSingle(),
  ]);
  if (!draft) return fail(db, user.id, actionId, preparing, "The owned Reel draft could not be loaded.");
  const producing = { ...preparing, productionStatus: "producing" };
  const { error: producingError } = await db.from("mara_pending_actions").update({ new_value: producing, result_summary: "Producing timed scenes, overlays, branding, and the review player." }).eq("id", actionId).eq("owner_user_id", user.id).eq("status", "pending");
  if (producingError) return fail(db, user.id, actionId, preparing, "Voom couldn't persist the production state.");
  const concept = String(action.new_value.concept ?? draft.title);
  const brandName = business?.brand_name ?? "Your business";
  const caption = draft.content;
  const copyContext: ViewerCopyContext = { concept, caption, brandName };
  // Viewer-facing copy is generated from TEXT ONLY (concept, caption, business
  // context). Uploaded private media is never sent to the AI provider. If the
  // provider is unavailable or returns unsafe copy, the deterministic fallback
  // keeps production working — internal shot directions never reach the screen.
  let viewerCopy = fallbackViewerCopy(copyContext);
  try {
    const provider = createAiProvider();
    const generated = await provider.structured({
      messages: [
        { role: "system", content: REEL_COPY_SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify({
          business: { name: brandName, description: String(business?.brand_description ?? "").slice(0, 800), industry: String(business?.industry ?? "").slice(0, 200), targetCustomer: String(business?.target_customer ?? "").slice(0, 300), mainGoal: String(business?.main_goal ?? "").slice(0, 300) },
          concept,
          caption,
          internalScriptForInterpretationOnly: String(action.new_value.script ?? "").slice(0, 1200),
          internalShotDirectionsForInterpretationOnly: (Array.isArray(action.new_value.shotInstructions) ? action.new_value.shotInstructions : []).slice(0, 5),
        }) },
      ],
      temperature: 0.25,
      maxTokens: 300,
      parse: (value) => viewerCopySchema.parse(value),
    });
    viewerCopy = enforceViewerCopy(generated, copyContext);
  } catch {
    viewerCopy = fallbackViewerCopy(copyContext);
  }
  const visuals = assignReelVisuals(assetPack.map((row) => ({ id: row.id, mimeType: String(row.mime_type), kind: assetKindForMime(String(row.mime_type)) as "image" | "video" })));
  const composition = buildReelComposition({ concept, caption, brandName, usesAsset, viewerCopy, visuals });
  const produced = { ...producing, productionStatus: "produced", assetReceived, assetCount: assetPack.length, reelComposition: composition };
  const { data: completed, error } = await db.from("mara_pending_actions").update({ new_value: produced, sanitized_arguments: { ...(action.new_value ?? {}), selectedProductionMethod: "create_with_mara", productionStatus: "produced" }, result_summary: "Produced a playable live Voom Reel composition with viewer-facing scenes. Ready for review; nothing was published.", error_summary: null }).eq("id", actionId).eq("owner_user_id", user.id).eq("status", "pending").select(ACTION_COLUMNS).single();
  if (error) return fail(db, user.id, actionId, producing, "Voom couldn't finish Reel production safely.");
  return Response.json({ action: completed, message: "Reel produced and ready for review." });
}

/**
 * Status of a Reel production. When a real video job is in flight this
 * request lazily polls the provider and, on success, validates and attaches
 * the video to the draft — the same lazy-advance used by Post Studio.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ actionId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const { actionId } = await params;
  if (!UUID_RE.test(actionId)) return Response.json({ error: "That Reel request is not valid." }, { status: 400 });
  const db = await createClient();
  const { data: action } = await db.from("mara_pending_actions").select(ACTION_COLUMNS).eq("id", actionId).eq("owner_user_id", user.id).eq("tool_name", "choose_reel_production").eq("status", "pending").maybeSingle();
  if (!action || !action.new_value || typeof action.new_value.draftId !== "string") return Response.json({ error: "That Reel request was not found." }, { status: 404 });
  const value = action.new_value as Record<string, unknown>;
  const productionStatus = String(value.productionStatus ?? "");
  const generationId = typeof value.generationId === "string" ? value.generationId : null;

  if (productionStatus === "video_generating" || productionStatus === "video_processing") {
    const admin = createAdminClient();
    if (!generationId) return Response.json({ action, error: "This Reel video lost its job record. Retry production." }, { status: 503 });
    const service = await buildVideoService(admin, user.id);
    if (!service) {
      // The provider stack is unavailable, so the job cannot be polled. Voom's
      // OWN hard timeout does not depend on that stack: a job that outlived it
      // is stopped here (a guarded database write — no provider call, no new
      // job, no charge) and the board card tells the truth, instead of both
      // staying "generating" forever. A job still inside its limit is reported
      // as-is, untouched.
      const enforced = await enforceVideoJobHardTimeout(admin, user.id, generationId).catch(() => null);
      if (enforced?.enforced) {
        const { data: timedOut } = await db.from("mara_pending_actions")
          .update({
            new_value: { ...value, productionStatus: "video_failed" },
            error_summary: videoJobSafeError(VIDEO_JOB_TIMEOUT_ERROR_CODE),
            result_summary: "Reel video production stopped safely after Voom's generation time limit. Nothing was published.",
          })
          .eq("id", actionId).eq("owner_user_id", user.id).eq("status", "pending").select(ACTION_COLUMNS).maybeSingle();
        return Response.json({ action: timedOut ?? action, generation: null }, { headers: { "Cache-Control": "no-store" } });
      }
      return Response.json({ action, message: "Create with MARA is temporarily unavailable. Your previous asset is unchanged." });
    }
    const generation = await latestVideoGeneration(admin, user.id, action.new_value.draftId as string);
    if (!generation || generation.id !== generationId) {
      return Response.json({ action, message: "This Reel video lost its job record. Retry production." });
    }
    try {
      const advanced = await advanceVideoJob(service, action.new_value.draftId as string, generationId, "reel");
      if (!advanced.ok) return Response.json({ action, error: "That generation could not be loaded. Please retry." }, { status: 404 });
      const status = advanced.generation.status;
      if (status === "generating" || status === "processing") {
        if (status === "processing" && productionStatus !== "video_processing") {
          const { data: current } = await db.from("mara_pending_actions").update({ new_value: { ...value, productionStatus: "video_processing" }, result_summary: "MARA is processing the generated video. Almost done." }).eq("id", actionId).eq("owner_user_id", user.id).eq("status", "pending").select(ACTION_COLUMNS).maybeSingle();
          return Response.json({ action: current ?? action, generation: advanced.view }, { headers: { "Cache-Control": "no-store" } });
        }
        return Response.json({ action, generation: advanced.view }, { headers: { "Cache-Control": "no-store" } });
      }
      if (status === "completed") {
        const { data: current, error } = await db.from("mara_pending_actions").update({ new_value: { ...value, productionStatus: "produced", generationId }, sanitized_arguments: { ...(action.sanitized_arguments ?? {}), productionStatus: "produced", generationId }, result_summary: "MARA generated this Reel video. It is stored privately in Voom and ready for review; nothing was published.", error_summary: null }).eq("id", actionId).eq("owner_user_id", user.id).eq("status", "pending").select(ACTION_COLUMNS).maybeSingle();
        if (error || !current) return Response.json({ action, generation: advanced.view }, { headers: { "Cache-Control": "no-store" } });
        return Response.json({ action: current, generation: advanced.view }, { headers: { "Cache-Control": "no-store" } });
      }
      const { data: current } = await db.from("mara_pending_actions").update({ new_value: { ...value, productionStatus: "video_failed" }, error_summary: advanced.view?.safeError ?? "Generation couldn't finish. Your previous asset is unchanged.", result_summary: "Reel video production stopped safely. Nothing was published." }).eq("id", actionId).eq("owner_user_id", user.id).eq("status", "pending").maybeSingle();
      return Response.json({ action: current ?? action, generation: advanced.view }, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return Response.json({ action, message: "Voom couldn't check that generation safely. Please retry." }, { headers: { "Cache-Control": "no-store" } });
    }
  }

  if (productionStatus === "produced" && generationId) {
    const admin = createAdminClient();
    const generation = await latestVideoGeneration(admin, user.id, action.new_value.draftId as string);
    const previewUrl = generation?.status === "completed" && typeof generation.storage_path === "string"
      ? await admin.storage.from("mara-media").createSignedUrl(generation.storage_path, 600).then((res) => res.data?.signedUrl ?? null).catch(() => null)
      : null;
    return Response.json({ action, generation: generation ? { id: generation.id, status: generation.status, durationSeconds: generation.duration_seconds, previewUrl } : null }, { headers: { "Cache-Control": "no-store" } });
  }

  return Response.json({ action }, { headers: { "Cache-Control": "no-store" } });
}

async function fail(db: Awaited<ReturnType<typeof createClient>>, ownerId: string, actionId: string, value: Record<string, unknown>, message: string) {
  await db.from("mara_pending_actions").update({ new_value: { ...value, productionStatus: "production_failed" }, error_summary: message, result_summary: "Reel production stopped safely. Nothing was published." }).eq("id", actionId).eq("owner_user_id", ownerId).eq("status", "pending");
  return Response.json({ error: message }, { status: 503 });
}
