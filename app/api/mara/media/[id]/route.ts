import { createHash } from "node:crypto";
import { createMediaProvider, getMediaConfig, MediaError } from "@/lib/media";
import { MEDIA_SELECT, toMediaView } from "@/lib/media/data";
import type { GeneratedMedia } from "@/lib/media/types";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { normalizePlan, canUseAutomationMode } from "@/lib/billing/plans";
import { normalizeAllowAutomaticPaidMedia } from "@/lib/mara/media-spend";
import { normalizeAutomationMode } from "@/lib/voom/automation";
import { guardAndReserveMedia, releaseReservationOnFailure, confirmReservation } from "@/lib/billing/entitlement-guard";

export const runtime = "nodejs";
export const maxDuration = 300;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const owned = await getOwnedGeneration((await params).id);
  if (owned instanceof Response) return owned;
  const admin = createAdminClient();
  let row = owned.row;
  if (row.status === "processing" && typeof row.provider_job_id === "string") row = await pollGeneration(admin, row) ?? row;
  return Response.json({ media: await toMediaView(admin, row) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const owned = await getOwnedGeneration((await params).id);
  if (owned instanceof Response) return owned;
  let action = "generate"; let prompt: string | null = null;
  try { const body = await request.json() as { action?: unknown; prompt?: unknown }; if (typeof body.action === "string") action = body.action; if (typeof body.prompt === "string") prompt = body.prompt.trim(); } catch { /* default */ }
  const admin = createAdminClient();
  const row = owned.row;
  if (action === "edit") {
    if (!prompt || prompt.length > 4000) return Response.json({ error: "The media description must be between 1 and 4,000 characters." }, { status: 400 });
    if (row.status === "processing") return Response.json({ error: "Wait for the current generation to finish before editing." }, { status: 409 });
    const nextStatus = row.media_type === "video" ? "pending_confirmation" : "queued";
    const { data, error } = await admin.from("mara_media_generations").update({ prompt, status: nextStatus, approval_status: "draft", provider_job_id: null, storage_path: null, mime_type: null, byte_size: null, completed_at: null, error_code: null }).eq("id", row.id).eq("owner_user_id", owned.userId).select(MEDIA_SELECT).single();
    if (error) return mediaDatabaseError();
    return Response.json({ media: await toMediaView(admin, data) });
  }
  if (action === "approve" || action === "reject") {
    if (row.status !== "completed") return Response.json({ error: "Wait for generation to finish first." }, { status: 409 });
    const { data, error } = await admin.from("mara_media_generations").update({ approval_status: action === "approve" ? "approved" : "rejected" }).eq("id", row.id).eq("owner_user_id", owned.userId).select(MEDIA_SELECT).single();
    if (error) return mediaDatabaseError();
    return Response.json({ media: await toMediaView(admin, data), message: action === "approve" ? "Media approved. Nothing was published." : "Media rejected." });
  }
  if (action === "cancel") {
    if (!["pending_confirmation", "queued", "failed"].includes(String(row.status))) return Response.json({ error: "This generation can no longer be cancelled." }, { status: 409 });
    const { data, error } = await admin.from("mara_media_generations").update({ status: "cancelled", error_code: null }).eq("id", row.id).eq("owner_user_id", owned.userId).select(MEDIA_SELECT).single();
    if (error) return mediaDatabaseError();
    return Response.json({ media: await toMediaView(admin, data) });
  }
  if (action === "regenerate") {
    const nextStatus = row.media_type === "video" ? "pending_confirmation" : "queued";
    const { data, error } = await admin.from("mara_media_generations").update({ status: nextStatus, provider_job_id: null, storage_path: null, mime_type: null, byte_size: null, completed_at: null, error_code: null }).eq("id", row.id).eq("owner_user_id", owned.userId).select(MEDIA_SELECT).single();
    if (error) return mediaDatabaseError();
    if (nextStatus === "pending_confirmation") return Response.json({ media: await toMediaView(admin, data) });
    return runGeneration(admin, data, owned.userId);
  }
  if (action !== "generate" && action !== "confirm") return Response.json({ error: "Unknown media action." }, { status: 400 });
  if (row.media_type === "video" && row.status === "pending_confirmation" && action !== "confirm") return Response.json({ error: "Confirm the estimated video cost first." }, { status: 409 });
  if (!["queued", "pending_confirmation", "failed"].includes(String(row.status))) return Response.json({ media: await toMediaView(admin, row) });
  return runGeneration(admin, row, owned.userId);
}

type BusinessBillingRow = { plan?: string | null; allow_automatic_paid_media?: unknown; automation_level?: string | null } | null;

async function loadBilling(admin: ReturnType<typeof createAdminClient>, ownerId: string) {
  try {
    const { data } = await admin.from("businesses").select("plan,allow_automatic_paid_media,automation_level").eq("owner_user_id", ownerId).maybeSingle();

    const business = data as BusinessBillingRow;
    const planId = normalizePlan(business?.plan);
    let mode = normalizeAutomationMode(business?.automation_level);
    if (!canUseAutomationMode(planId, mode)) {
      mode = planId === "pro" ? "assisted" : "manual";
    }
    return {
      planId,
      allowAutomatic: normalizeAllowAutomaticPaidMedia(business?.allow_automatic_paid_media),
      mode,
    };
  } catch {
    return { planId: "free" as const, allowAutomatic: false, mode: "assisted" as const };
  }
}

async function runGeneration(admin: ReturnType<typeof createAdminClient>, row: Record<string, unknown>, ownerId: string) {
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count } = await admin.from("mara_media_generations").select("id", { count: "exact", head: true }).eq("owner_user_id", ownerId).gte("updated_at", since).in("status", ["processing", "completed"]);
  if ((count ?? 0) >= 4) return Response.json({ error: "MARA is generating media too quickly. Wait a minute and retry." }, { status: 429 });
  if (row.media_type === "video" && !await withinMonthlySpendLimit(admin, ownerId, Number(row.estimated_cost_usd ?? 0))) {
    return Response.json({ error: "This video would exceed your configured monthly media limit. No generation was started." }, { status: 402 });
  }

  // V1 credit boundary: reserve BEFORE provider
  const billing = await loadBilling(admin, ownerId);
  const mediaType = row.media_type === "video" ? "video" as const : "image" as const;
  const durationSeconds = mediaType === "video" ? Number(row.duration_seconds ?? 8) : undefined;
  const generationId = String(row.id);
  const source = (row.spend_source as string) === "autopilot" ? "autopilot" as const : "user_request" as const;

  const guard = await guardAndReserveMedia(admin, {
    ownerId,
    planId: billing.planId,
    mode: billing.mode,
    allowAutomaticPaidMedia: billing.allowAutomatic,
    mediaType,
    durationSeconds,
    source,
    generationId,
  });
  if (!guard.allow) {
    const status = guard.code === "insufficient_credits" || guard.code === "plan_not_allowed" ? 402 : 403;
    return Response.json({ error: guard.message, code: guard.code, creditsNeeded: guard.credits }, { status });
  }

  const { data: processing, error } = await admin.from("mara_media_generations").update({ status: "processing", error_code: null }).eq("id", row.id).eq("owner_user_id", ownerId).in("status", ["queued", "pending_confirmation", "failed"]).select(MEDIA_SELECT).maybeSingle();
  if (error) {
    await releaseReservationOnFailure(admin, ownerId, generationId).catch(() => null);
    return mediaDatabaseError();
  }
  if (!processing) {
    await releaseReservationOnFailure(admin, ownerId, generationId).catch(() => null);
    const { data } = await admin.from("mara_media_generations").select(MEDIA_SELECT).eq("id", row.id).eq("owner_user_id", ownerId).single();
    if (!data) return mediaDatabaseError();
    return Response.json({ media: await toMediaView(admin, data) });
  }
  try {
    const config = getMediaConfig(); const provider = createMediaProvider(config);
    const result = processing.media_type === "image"
      ? await provider.generateImage({ prompt: String(processing.prompt), aspectRatio: processing.aspect_ratio })
      : await provider.generateVideo({ prompt: String(processing.prompt), aspectRatio: processing.aspect_ratio, durationSeconds: Number(processing.duration_seconds ?? 8) });
    if (result.kind === "pending") {
      const { data } = await admin.from("mara_media_generations").update({ provider: config.provider, provider_job_id: result.providerJobId }).eq("id", processing.id).select(MEDIA_SELECT).single();
      if (!data) {
        await releaseReservationOnFailure(admin, ownerId, generationId).catch(() => null);
        return mediaDatabaseError();
      }
      // Pending video: reservation stays, will settle on completion
      return Response.json({ media: await toMediaView(admin, data) }, { status: 202 });
    }
    await confirmReservation(admin, ownerId, generationId).catch(() => null);
    return completeGeneration(admin, processing, ownerId, config.provider, result);
  } catch (reason) {
    await releaseReservationOnFailure(admin, ownerId, generationId).catch(() => null);
    const code = reason instanceof MediaError ? reason.code : "unavailable";
    const { data } = await admin.from("mara_media_generations").update({ status: "failed", error_code: code, provider_diagnostic: reason instanceof MediaError ? reason.diagnostic : null }).eq("id", processing.id).eq("owner_user_id", ownerId).select(MEDIA_SELECT).single();
    if (!data) return mediaDatabaseError();
    return Response.json({ media: await toMediaView(admin, data), error: friendlyMediaError(code) }, { status: code === "rate_limited" ? 429 : 503 });
  }
}

async function withinMonthlySpendLimit(admin: ReturnType<typeof createAdminClient>, ownerId: string, nextCost: number) {
  const limit = Number(process.env.MEDIA_MONTHLY_SPEND_LIMIT_USD);
  if (!Number.isFinite(limit) || limit <= 0) return true;
  const now = new Date(); const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const { data, error } = await admin.from("mara_media_generations").select("estimated_cost_usd").eq("owner_user_id", ownerId).eq("media_type", "video").gte("created_at", monthStart).in("status", ["processing", "completed"]);
  if (error) return false;
  const spent = (data ?? []).reduce((total, item) => total + Number(item.estimated_cost_usd ?? 0), 0);
  return spent + nextCost <= limit;
}

async function pollGeneration(admin: ReturnType<typeof createAdminClient>, row: Record<string, unknown>) {
  try {
    const config = getMediaConfig(); const result = await createMediaProvider(config).pollVideo(String(row.provider_job_id));
    if (result.kind === "pending") return row;
    const response = await completeGeneration(admin, row, String(row.owner_user_id), config.provider, result);
    const payload = await response.json() as { media: Record<string, unknown> };
    const { data } = await admin.from("mara_media_generations").select(`${MEDIA_SELECT},owner_user_id,provider_job_id`).eq("id", payload.media.id).single();
    return data;
  } catch (reason) {
    const code = reason instanceof MediaError ? reason.code : "unavailable";
    const { data } = await admin.from("mara_media_generations").update({ status: "failed", error_code: code }).eq("id", row.id).select(`${MEDIA_SELECT},owner_user_id,provider_job_id`).single();
    return data;
  }
}

async function completeGeneration(admin: ReturnType<typeof createAdminClient>, row: Record<string, unknown>, ownerId: string, provider: string, media: GeneratedMedia) {
  const limit = row.media_type === "video" ? 500 * 1024 * 1024 : 20 * 1024 * 1024;
  if (!media.bytes.length || media.bytes.length > limit) throw new MediaError("malformed_response");
  const ext = media.mimeType === "video/mp4" ? "mp4" : media.mimeType.split("/")[1];
  const digest = createHash("sha256").update(media.bytes).digest("hex").slice(0, 16);
  const path = `${ownerId}/${row.id}/${digest}.${ext}`;
  const upload = await admin.storage.from("mara-media").upload(path, media.bytes, { contentType: media.mimeType, upsert: true, cacheControl: "3600" });
  if (upload.error) throw new MediaError("unavailable");
  const { data, error } = await admin.from("mara_media_generations").update({ status: "completed", provider, storage_path: path, mime_type: media.mimeType, byte_size: media.bytes.length, completed_at: new Date().toISOString(), error_code: null }).eq("id", row.id).eq("owner_user_id", ownerId).select(MEDIA_SELECT).single();
  if (error) throw new MediaError("unavailable");
  return Response.json({ media: await toMediaView(admin, data) });
}

async function getOwnedGeneration(id: string) {
  if (!UUID_RE.test(id)) return Response.json({ error: "Invalid media generation." }, { status: 400 });
  const user = await getCurrentUser(); if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const db = await createClient();
  const { data, error } = await db.from("mara_media_generations").select(`${MEDIA_SELECT},owner_user_id,provider_job_id`).eq("id", id).eq("owner_user_id", user.id).maybeSingle();
  if (error) return mediaDatabaseError();
  if (!data) return Response.json({ error: "Media generation not found." }, { status: 404 });
  return { row: data as Record<string, unknown>, userId: user.id };
}

function friendlyMediaError(code: string) { return code === "not_configured" ? "Media generation is built but its provider is not configured yet." : code === "rate_limited" ? "The media generator is busy. Wait a moment and retry." : code === "rejected" ? "That media request could not be generated. Try adjusting the description." : "MARA couldn't generate that media just now. Please retry."; }
function mediaDatabaseError() { return Response.json({ error: "MARA's media storage is not ready yet." }, { status: 503 }); }
