"use server";

/**
 * Server actions behind the ONE Marketing Plan card.
 *
 * Every action advances the SAME workflow item (its `mara_drafts` row, its
 * calendar mirror and its queue row) — no duplicate drafts are ever created.
 * They reuse the existing systems only:
 *
 *   - media via the existing workflow media module (OpenRouter Seedream
 *     images, Seedance/Magic-Hour videos through startPostStudioVideo),
 *   - approval/scheduling via the existing approvePostDraft ->
 *     syncPostToCalendar -> syncPostToPublishQueue chain,
 *   - Post-now/Reschedule/Cancel via the SAME idempotent queue functions
 *     (one publish identity per draft, forever),
 *   - the existing business-timezone past-time guard (checkSchedule) on every
 *     schedule change, client-supplied times are never trusted.
 *
 * Mode semantics are preserved: Autopilot may advance safe content on its own
 * (existing evaluator, elsewhere); the actions here never publish anything
 * directly — only the existing publishing worker does.
 */

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";
import type { AdminClient } from "@/lib/post/server-data";
import { checkSchedule } from "@/lib/voom/schedule-guard";
import { accountTimezone } from "@/lib/voom/timezone";
import { enqueuePublishItem } from "@/lib/instagram/publish-queue";
import { isPublishableMime, publishMediaKindForMime, truncateCaption } from "@/lib/instagram/publishing";
import {
  approvePostDraft,
  cancelPostSchedule,
  getPostDraft,
  syncPostToCalendar,
  type PostView,
} from "@/lib/post/server-data";
import { produceWorkflowMedia } from "./media";

export type ActionResult = { ok: true; message: string } | { ok: false; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function context() {
  const user = await getCurrentUser();
  if (!user) return null;
  return { userId: user.id, admin: createAdminClient() };
}

/** Loads an owned workflow draft (source_plan_item_key = local slot date). */
async function loadOwnedDraft(admin: AdminClient, ownerId: string, draftId: string) {
  if (!UUID_RE.test(draftId)) return null;
  const { data } = await admin.from("mara_drafts")
    .select("id,kind,channel,title,content,proposed_publish_at,status,media_brief,conversation_id,source_plan_item_key")
    .eq("owner_user_id", ownerId).eq("id", draftId).maybeSingle();
  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(String(data.source_plan_item_key ?? ""))) return null;
  return data as Record<string, unknown>;
}

function draftContentType(row: Record<string, unknown>): "post" | "reel" | "story" {
  const kind = String(row.kind ?? "instagram_post");
  return kind === "reel" ? "reel" : kind === "story" ? "story" : "post";
}

function revalidate() {
  revalidatePath("/app/plan");
  revalidatePath("/app/today");
  revalidatePath("/app/calendar");
  revalidatePath("/app/approvals");
  revalidatePath("/app", "layout");
}

/**
 * "Create with MARA" / "Regenerate" / "Retry generation" on the SAME item.
 *
 * Images (Post 1:1, Story 9:16) go through the existing Seedream-backed
 * provider abstraction; Reels go through the existing durable video job
 * service (Seedance, Magic Hour fallback). Retry safety is decided by
 * `decideMediaStart` (lib/voom/workflow/media.ts): while a generation is in
 * flight a repeated click is a no-op (never a second charge); after a
 * finished attempt an explicit retry is a fresh attempt; `regenerate` passes
 * a fresh token so it is deliberately a NEW generation. Nothing is published.
 */
export async function producePlanItemMedia(draftId: string, options: { regenerate?: boolean } = {}): Promise<ActionResult> {
  const ctx = await context();
  if (!ctx) return { ok: false, error: "Your session has expired. Please log in again." };
  const draft = await loadOwnedDraft(ctx.admin, ctx.userId, draftId);
  if (!draft) return { ok: false, error: "That plan item was not found." };
  const contentType = draftContentType(draft);
  if (contentType === "reel" && options.regenerate) {
    // Regenerate is an explicit second generation: new identity — but only
    // when nothing is in flight (the policy resolves to "exists" otherwise,
    // so a repeated click can never pay for a second generation).
    const { randomUUID } = await import("node:crypto");
    const outcome = await produceWorkflowMedia(ctx.admin, mediaRequest(ctx.userId, draft, contentType), { idempotencyToken: `workflow-${draftId}:${randomUUID()}` });
    if (!outcome.ok) return { ok: false, error: "MARA couldn't start that Reel generation. Nothing was changed." };
    revalidate();
    if (outcome.state === "exists") {
      return { ok: true, message: "A generation is already in flight for this item — nothing new was started, so nothing was charged." };
    }
    return { ok: true, message: "MARA is generating a fresh Reel for this item. Nothing was published." };
  }
  const outcome = await produceWorkflowMedia(ctx.admin, mediaRequest(ctx.userId, draft, contentType));
  if (!outcome.ok) return { ok: false, error: "MARA couldn't generate that visual. Nothing was changed — retrying cannot double-charge you." };
  revalidate();
  if (outcome.state === "exists") {
    return { ok: true, message: "A generation is already in flight for this item — nothing new was started, so nothing was charged." };
  }
  return { ok: true, message: "MARA is generating the visual for this item. Nothing was published." };
}

function mediaRequest(ownerId: string, draft: Record<string, unknown>, contentType: "post" | "reel" | "story") {
  return {
    ownerId,
    draftId: String(draft.id),
    conversationId: String(draft.conversation_id ?? ""),
    contentType,
    concept: String(draft.title ?? ""),
    visualBrief: String(draft.media_brief ?? draft.title ?? ""),
  };
}

/**
 * "Approve & schedule". Advances the SAME item through the existing approval
 * chain. When the media is ready it lands in Scheduled with a queue row;
 * when it is still generating, the queue row is held truthfully in
 * 'waiting_for_media' and self-heals when the media arrives.
 */
export async function approvePlanItem(draftId: string): Promise<ActionResult> {
  const ctx = await context();
  if (!ctx) return { ok: false, error: "Your session has expired. Please log in again." };
  const draft = await loadOwnedDraft(ctx.admin, ctx.userId, draftId);
  if (!draft) return { ok: false, error: "That plan item was not found." };
  if (String(draft.status) === "approved") return { ok: true, message: "Already approved and scheduled." };
  try {
    const view = await approvePostDraft(ctx.admin, ctx.userId, draftId);
    if (!view) return { ok: false, error: "That plan item was not found." };
  } catch {
    return { ok: false, error: "Voom couldn't approve that item safely. Nothing was published — please retry." };
  }
  await resolveOpenApprovalCard(ctx.admin, ctx.userId, draftId);
  revalidate();
  const post = await getPostDraft(ctx.admin, ctx.userId, draftId);
  return { ok: true, message: post?.visualReady ? "Approved and scheduled. Voom publishes it at the scheduled time." : "Approved. Its schedule is held while the visual finishes generating." };
}

/** Resolves the item's open approval card, if any (approval happened in place). */
async function resolveOpenApprovalCard(admin: AdminClient, ownerId: string, draftId: string) {
  await admin.from("mara_pending_actions")
    .update({ status: "confirmed", result_summary: "Approved from the Marketing Plan card. Nothing was published.", executed_at: new Date().toISOString() })
    .eq("owner_user_id", ownerId).eq("tool_name", "propose_calendar_item")
    .in("status", ["pending", "failed"]).contains("sanitized_arguments", { sourceDraftId: draftId });
}

/**
 * "Change time" / "Reschedule". Validates with the EXISTING business-timezone
 * guard (client and server enforce identical rules) and updates the draft +
 * calendar mirror + queue row through the idempotent sync. A publish time is
 * never moved into the past, and a published or in-flight item is never
 * touched (the queue function refuses).
 */
export async function reschedulePlanItem(draftId: string, date: string, time: string): Promise<ActionResult> {
  const ctx = await context();
  if (!ctx) return { ok: false, error: "Your session has expired. Please log in again." };
  const draft = await loadOwnedDraft(ctx.admin, ctx.userId, draftId);
  if (!draft) return { ok: false, error: "That plan item was not found." };
  const { data: business } = await ctx.admin.from("businesses").select("timezone").eq("owner_user_id", ctx.userId).maybeSingle();
  const timeZone = accountTimezone((business as { timezone?: string | null } | null)?.timezone);
  const guard = checkSchedule({ date, time, now: new Date(), timeZone });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { error } = await ctx.admin.from("mara_drafts")
    .update({ proposed_publish_at: guard.publishAt })
    .eq("owner_user_id", ctx.userId).eq("id", draftId);
  if (error) return { ok: false, error: "Voom couldn't save that schedule. Please retry." };
  try { await syncPostToCalendar(ctx.admin, ctx.userId, draftId); } catch {
    return { ok: false, error: "The time was saved, but the schedule mirror could not be updated. Please retry." };
  }
  revalidate();
  return { ok: true, message: "Rescheduled." };
}

/**
 * "Post now" — valid from Missed or Failed states (and legitimately from any
 * approved item whose media is ready). NO late automatic publishing happens
 * anywhere: this is an explicit user action. It works entirely through the
 * existing idempotent queue: the row keeps its ONE publish identity, its
 * scheduled_at moves to now, and the existing worker claims it within
 * minutes. A published item can never be posted twice.
 */
export async function postPlanItemNow(draftId: string): Promise<ActionResult> {
  const ctx = await context();
  if (!ctx) return { ok: false, error: "Your session has expired. Please log in again." };
  const draft = await loadOwnedDraft(ctx.admin, ctx.userId, draftId);
  if (!draft) return { ok: false, error: "That plan item was not found." };
  if (String(draft.status) !== "approved") return { ok: false, error: "Approve this item before posting it." };
  const view = await getPostDraft(ctx.admin, ctx.userId, draftId);
  if (!view) return { ok: false, error: "That plan item was not found." };
  if (!view.visualReady || !view.visual) return { ok: false, error: "This item has no stored visual yet, so it cannot post now." };
  const mediaKind = publishMediaKindForMime(view.visual.mimeType, view.kind);
  if (!mediaKind || !isPublishableMime(view.visual.mimeType)) return { ok: false, error: "This item's file type cannot publish to Instagram." };
  try {
    await enqueuePublishItem(ctx.admin, {
      ownerId: ctx.userId,
      draftId,
      calendarItemId: view.calendarItemId,
      mediaKind,
      caption: mediaKind === "story" ? "" : truncateCaption(view.composedCaption),
      scheduledAt: new Date().toISOString(),
    });
  } catch {
    return { ok: false, error: "Voom couldn't queue that safely. Please retry — it cannot post twice." };
  }
  revalidate();
  return { ok: true, message: "Queued to post now through the normal publishing worker. It cannot post twice." };
}

/**
 * "Cancel schedule" / "Discard". Un-approves the draft (back to Needs
 * content/Planned semantics), removes the calendar mirror and cancels the
 * queue row. Published or in-flight items are never cancelled by the queue
 * function — that guarantee is reused, not reimplemented.
 */
export async function cancelPlanItemSchedule(draftId: string): Promise<ActionResult> {
  const ctx = await context();
  if (!ctx) return { ok: false, error: "Your session has expired. Please log in again." };
  const draft = await loadOwnedDraft(ctx.admin, ctx.userId, draftId);
  if (!draft) return { ok: false, error: "That plan item was not found." };
  if (String(draft.status) === "approved") {
    const { error } = await ctx.admin.from("mara_drafts").update({ status: "draft" }).eq("owner_user_id", ctx.userId).eq("id", draftId);
    if (error) return { ok: false, error: "Voom couldn't cancel that safely. Please retry." };
  }
  try { await cancelPostSchedule(ctx.admin, ctx.userId, draftId); } catch {
    return { ok: false, error: "The item was reset, but its schedule mirror could not be cleaned up. Please retry." };
  }
  await ctx.admin.from("mara_pending_actions")
    .update({ status: "cancelled", result_summary: "Cancelled from the Marketing Plan card. Nothing changed.", executed_at: new Date().toISOString() })
    .eq("owner_user_id", ctx.userId).eq("tool_name", "propose_calendar_item")
    .in("status", ["pending", "failed"]).contains("sanitized_arguments", { sourceDraftId: draftId });
  revalidate();
  return { ok: true, message: "Schedule cancelled. The item stays in your plan as a draft. Nothing was published." };
}

/**
 * Records the user's Reel production choice on the item ("Film it myself" /
 * "Upload video") by opening the SAME approval card used by the rolling
 * workflow, pre-seeded with the chosen method. Assisted stops at Needs
 * approval exactly as before.
 */
export async function choosePlanItemProduction(draftId: string, method: "film_yourself" | "upload_asset" | "create_with_mara"): Promise<ActionResult> {
  const ctx = await context();
  if (!ctx) return { ok: false, error: "Your session has expired. Please log in again." };
  const draft = await loadOwnedDraft(ctx.admin, ctx.userId, draftId);
  if (!draft) return { ok: false, error: "That plan item was not found." };
  const { ensureWorkflowApprovalCard } = await import("./service");
  const view: PostView | null = await getPostDraft(ctx.admin, ctx.userId, draftId);
  if (method === "create_with_mara") return producePlanItemMedia(draftId);
  const status = method === "film_yourself" ? "Waiting for you to film the requested vertical clip." : "Waiting for one existing asset upload.";
  try {
    await ensureWorkflowApprovalCard(ctx.admin, ctx.userId, {
      draftId,
      conversationId: String(draft.conversation_id ?? ""),
      concept: String(draft.title ?? ""),
      caption: view?.composedCaption ?? String(draft.content ?? ""),
      publishAt: String(draft.proposed_publish_at ?? ""),
      contentType: draftContentType(draft),
      timeZone: accountTimezone(),
      productionStatus: method === "film_yourself" ? "waiting_for_filming" : "waiting_for_asset_upload",
      statusNote: status,
    });
  } catch {
    return { ok: false, error: "Voom couldn't record that choice safely. Please retry." };
  }
  revalidate();
  return { ok: true, message: status };
}
