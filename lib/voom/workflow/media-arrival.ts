import "server-only";

import { evaluateAutopilotRecommendation } from "@/lib/mara/autopilot-safety";
import { APPROVAL_CONTENT_CHANGED, type AdminClient } from "@/lib/post/server-data";
import { assertAutonomousWorkAllowed } from "@/lib/voom/automation-safety";
import { accountTimezone } from "@/lib/voom/timezone";
import {
  approveWorkflowItem,
  draftHasVisual,
  ensureWorkflowApprovalCard,
  recordAutoApproval,
} from "./service";
import type { WorkflowItem } from "./rolling-plan";

/**
 * Asynchronous MARA media (e.g. a Reel video finishing minutes after the
 * Autopilot run) arrives for a draft Autopilot parked as awaiting media.
 *
 * Complete-content approval (migration 0059): an approval never extends to
 * media that did not exist when it was given. So instead of inheriting an
 * earlier approval, Autopilot evaluates the FINAL post here — current mode,
 * emergency pause and plan entitlement, the deterministic safety checks on
 * the final caption and schedule, and the presence of the stored media —
 * and approves exactly the content version it evaluated (compare-and-swap).
 *
 * Only drafts carrying the durable `autopilotAwaitingMedia` marker are ever
 * considered, so a user's own upload, edit or withdrawal is never
 * auto-approved here, and approving (a status-only write) cannot re-trigger
 * it: no approval loop. Every outcome clears the marker except "no media
 * yet" and a concurrent change, which the next arrival/run re-evaluates.
 */
export type MediaArrivalOutcome =
  | "not_awaiting"
  | "no_media"
  | "approved"
  | "held_for_review"
  | "autonomy_blocked"
  | "content_changed";

export interface MediaArrivalDeps {
  /** Approves exactly `contentVersion`; throws APPROVAL_CONTENT_CHANGED otherwise. */
  approve(admin: AdminClient, ownerId: string, draftId: string, contentVersion: number): Promise<unknown>;
  recordAudit: typeof recordAutoApproval;
  openApprovalCard: typeof ensureWorkflowApprovalCard;
}

const defaultDeps: MediaArrivalDeps = {
  approve: (admin, ownerId, draftId, contentVersion) => approveWorkflowItem(admin, ownerId, draftId, "autopilot", contentVersion),
  recordAudit: recordAutoApproval,
  openApprovalCard: ensureWorkflowApprovalCard,
};

export async function completeAutopilotAfterMediaArrival(
  admin: AdminClient,
  ownerId: string,
  draftId: string,
  now: Date = new Date(),
  deps: MediaArrivalDeps = defaultDeps,
): Promise<MediaArrivalOutcome> {
  const { data: draft, error } = await admin.from("mara_drafts")
    .select("id,conversation_id,kind,title,content,proposed_publish_at,status,content_meta,content_version")
    .eq("owner_user_id", ownerId).eq("id", draftId).maybeSingle();
  if (error) throw new Error("media_arrival_read_failed");
  if (!draft) return "not_awaiting";
  const meta = draft.content_meta && typeof draft.content_meta === "object" ? draft.content_meta as Record<string, unknown> : {};
  if (!meta.autopilotAwaitingMedia) return "not_awaiting";
  if (draft.status !== "draft") {
    await clearAwaitingMarker(admin, ownerId, draftId, meta);
    return "not_awaiting";
  }
  if (!(await draftHasVisual(admin, ownerId, draftId))) return "no_media";

  // Mode, pause and entitlement are re-read now — never trusted from the run
  // that queued the media. If Autopilot no longer applies, nothing is
  // approved; the rolling plan handles the item under the current mode.
  try {
    await assertAutonomousWorkAllowed(admin, ownerId);
  } catch {
    await clearAwaitingMarker(admin, ownerId, draftId, meta);
    return "autonomy_blocked";
  }

  const rawPublishAt = draft.proposed_publish_at as string | Date | null;
  const publishAt = rawPublishAt && Number.isFinite(new Date(rawPublishAt).getTime()) ? new Date(rawPublishAt).toISOString() : "";
  const item: WorkflowItem = {
    draftId,
    slotKey: "",
    channel: "instagram",
    format: draft.kind === "reel" ? "reel" : draft.kind === "story" ? "story" : "post",
    contentType: draft.kind === "reel" ? "reel" : draft.kind === "story" ? "story" : "post",
    concept: String(draft.title ?? ""),
    caption: String(draft.content ?? ""),
    publishAt,
    status: "draft",
    contentVersion: Number(draft.content_version),
  };
  const { data: business } = await admin.from("businesses").select("timezone").eq("owner_user_id", ownerId).maybeSingle();
  const timeZone = accountTimezone((business as { timezone?: string | null } | null)?.timezone);
  const conversationId = String(draft.conversation_id ?? "");

  const safety = evaluateAutopilotRecommendation({ title: item.concept, content: item.caption, publishAt }, now);
  if (!safety.safe) {
    // Held for the owner: the card shows the complete post, media included.
    await deps.openApprovalCard(admin, ownerId, {
      draftId, conversationId, concept: item.concept, caption: item.caption, publishAt,
      contentType: item.contentType as "post" | "reel" | "story", timeZone,
    });
    await clearAwaitingMarker(admin, ownerId, draftId, meta);
    return "held_for_review";
  }

  try {
    await deps.approve(admin, ownerId, draftId, item.contentVersion as number);
  } catch (reason) {
    if (reason instanceof Error && reason.message === APPROVAL_CONTENT_CHANGED) return "content_changed";
    throw reason;
  }
  await deps.recordAudit(admin, { ownerId, conversationId, item, checks: safety.checks, timeZone });
  await clearAwaitingMarker(admin, ownerId, draftId, meta);
  return "approved";
}

async function clearAwaitingMarker(admin: AdminClient, ownerId: string, draftId: string, meta: Record<string, unknown>) {
  const { autopilotAwaitingMedia: _cleared, ...rest } = meta;
  void _cleared;
  await admin.from("mara_drafts").update({ content_meta: rest }).eq("owner_user_id", ownerId).eq("id", draftId);
}
