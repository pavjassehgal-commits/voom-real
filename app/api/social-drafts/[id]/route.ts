import { getCurrentUser } from "@/lib/voom/server-data";
import { getSocialDraft, updateSocialDraft } from "@/lib/social/server-drafts";
import { createAdminClient } from "@/utils/supabase/admin";
import { z } from "zod";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Multi-Social Core — read/edit/approve ONE TikTok or YouTube planning draft.
 *
 * Editing text, setting a schedule, declaring the TikTok privacy or the
 * YouTube audience/privacy and recording an approval all stay inside Voom.
 * Approval is NOT publication on either channel:
 *   - TikTok approval + schedule mirrors the item into the durable
 *     tiktok_publish_queue (migration 0049); only the cron worker uploads,
 *     and only TikTok's own PUBLISH_COMPLETE post status ever establishes
 *     Published.
 *   - YouTube approval + schedule mirrors the item into the durable
 *     youtube_publish_queue (migration 0047); only the cron worker uploads,
 *     and only YouTube's own confirmation (a real video id with
 *     uploadStatus='processed') ever establishes Published.
 * No credit is spent and no media is generated.
 */
const patchSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  caption: z.string().trim().max(4000).optional(),
  description: z.string().trim().max(5000).optional(),
  concept: z.string().trim().max(300).optional(),
  script: z.array(z.string().trim().max(400)).max(40).optional(),
  scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),
  decision: z.enum(["approved", "draft"]).optional(),
  /** Explicit YouTube declarations. null CLEARS a declaration (never a guess). */
  madeForKids: z.boolean().nullable().optional(),
  privacy: z.enum(["public", "private", "unlisted"]).nullable().optional(),
  /**
   * Explicit TikTok privacy declaration (TikTok's own four values).
   * null CLEARS the declaration (never a guess) — TikTok has no default
   * privacy level, so an undeclared item waits visibly.
   */
  tiktokPrivacy: z.enum(["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"]).nullable().optional(),
}).strict();

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return Response.json({ error: "That content was not found." }, { status: 404 });
  try {
    const draft = await getSocialDraft(createAdminClient(), user.id, id);
    if (!draft) return Response.json({ error: "That content was not found." }, { status: 404 });
    return Response.json({ draft }, { headers: { "Cache-Control": "no-store" } });
  } catch (reason) {
    const queueReadError = socialQueueReadError(reason);
    return Response.json({ error: queueReadError ?? "Voom couldn't load that content. Please retry." }, { status: 503 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return Response.json({ error: "That content was not found." }, { status: 404 });

  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "That request was not valid." }, { status: 400 }); }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Check the content details before saving." }, { status: 400 });

  const scheduledAt = parsed.data.scheduledAt;
  if (scheduledAt && Date.parse(scheduledAt) < Date.now() - 5 * 60_000) {
    return Response.json({ error: "Choose a date in the future to schedule this." }, { status: 400 });
  }

  try {
    const draft = await updateSocialDraft(createAdminClient(), user.id, id, parsed.data);
    if (!draft) return Response.json({ error: "That content was not found." }, { status: 404 });
    // The response is based on the row actually returned by the durable
    // provider queue. A successful approval write alone is never described as
    // queued, scheduled, uploading or published.
    const approvalMessage = socialApprovalMessage(draft);
    return Response.json({
      draft,
      message: parsed.data.decision === "approved"
        ? approvalMessage
        : "Saved inside Voom. Nothing was published.",
    });
  } catch (reason) {
    const code = reason instanceof Error ? reason.message : "";
    if (code.includes("publish_enqueue_failed")) {
      const channel = code.startsWith("youtube_") ? "YouTube" : "TikTok";
      return Response.json({
        error: `Approval was recorded, but Voom couldn't confirm the durable ${channel} queue sync. Nothing was published. Retry saving or scheduling to safely sync it.`,
      }, { status: 503 });
    }
    if (code === "social_draft_provider_owned") {
      return Response.json({
        error: "The provider already owns this video, so Voom made no changes. Uploading, processing, and published content cannot be cancelled or rewritten.",
      }, { status: 409 });
    }
    if (code.includes("publish_cancel_failed") || code === "social_draft_queue_cancel_not_confirmed") {
      return Response.json({
        error: "Voom couldn't confirm the durable queue cancellation. No draft or calendar changes were saved. Retry when the queue is available.",
      }, { status: 503 });
    }
    if (code === "social_calendar_sync_failed") {
      return Response.json({
        error: "The draft was saved, but Voom couldn't sync the calendar mirror. Nothing was published. Retry saving or scheduling.",
      }, { status: 503 });
    }
    const queueReadError = socialQueueReadError(reason);
    return Response.json({ error: queueReadError ?? "Voom couldn't save that content. Please retry." }, { status: 503 });
  }
}

function socialQueueReadError(reason: unknown): string | null {
  const code = reason instanceof Error ? reason.message : "";
  if (code.endsWith("publish_queue_read_failed")) {
    const channel = code.startsWith("youtube_") ? "YouTube" : "TikTok";
    return `Voom couldn't confirm the durable ${channel} queue state. No queued or published status is being assumed; refresh and retry.`;
  }
  return null;
}

function socialApprovalMessage(draft: NonNullable<Awaited<ReturnType<typeof getSocialDraft>>>) {
  const channel = draft.channel === "youtube" ? "YouTube" : "TikTok";
  if (!draft.scheduledAt) {
    return `Approved inside Voom. Add a schedule to sync this to the durable ${channel} queue — nothing has been published.`;
  }
  switch (draft.queueStatus) {
    case "scheduled":
      return `Approved and confirmed on the durable ${channel} queue for its scheduled time. Published appears only after ${channel} confirms.`;
    case "waiting_for_media":
      return `Approved and on the durable ${channel} queue, but publishing is held until a video file is ready. Nothing has been published.`;
    case "needs_declaration":
      return `Approved and on the durable ${channel} queue, but a required audience or privacy declaration is still needed. Nothing has been published.`;
    case "permission_required":
      return `Approved and recorded on the durable ${channel} queue, but its provider connection or permission is required before publishing.`;
    case "uploading":
    case "posting":
      return `${channel} is receiving the video. It is not Published until ${channel} confirms.`;
    case "provider_processing":
      return `${channel} is processing the video. It is not Published until ${channel} confirms completion.`;
    case "published":
      return `${channel} confirmed this video as Published.`;
    case "failed":
      return `The durable ${channel} queue records a failed attempt${draft.queueFailureMessage ? `: ${draft.queueFailureMessage}` : ""}. Nothing new was reported as published.`;
    case "cancelled":
      return `The ${channel} queue item is cancelled, so this approval is not scheduled for publishing.`;
    default:
      return `Approval was recorded, but the durable ${channel} queue sync is not confirmed. Nothing has been published.`;
  }
}
