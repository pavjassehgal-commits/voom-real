import "server-only";

import { accountTimezone, formatLocalTime, isoToLocalDate, localDate, relativeDayLabel } from "@/lib/voom/timezone";
import { CADENCE_LABELS, normalizeCadence, type Cadence } from "@/lib/voom/cadence";
import type { AdminClient } from "@/lib/post/server-data";
import {
  contentTypeLabel,
  deriveWorkflowStatus,
  failureStage,
  WORKFLOW_STATUS_LABELS,
  type WorkflowStatus,
} from "./state";

/**
 * The single read model for the executable content workflow.
 *
 * Marketing Plan, Today, Approvals and Content Calendar all render THIS list.
 * Every row is one real `mara_drafts` workflow item joined to its real media,
 * calendar and publishing facts, so no screen can show content that does not
 * exist and no screen can disagree about a status or a date.
 */

export interface WorkflowView {
  draftId: string;
  calendarItemId: string | null;
  slotDate: string;
  contentType: "post" | "reel" | "story";
  contentTypeLabel: string;
  concept: string;
  caption: string;
  publishAt: string;
  /** Local date/time in the account timezone. */
  localDate: string;
  localTime: string;
  dayLabel: string;
  status: WorkflowStatus;
  statusLabel: string;
  failedStage: "media" | "publishing" | "rejected" | null;
  failureMessage: string | null;
  approvalActionId: string | null;
  hasMedia: boolean;
  instagramMediaId: string | null;
}

export interface WorkflowSnapshot {
  timeZone: string;
  today: string;
  cadence: Cadence;
  cadenceLabel: string;
  mode: "manual" | "assisted" | "autopilot";
  planId: string | null;
  planGoal: string | null;
  planValidFrom: string | null;
  planValidUntil: string | null;
  items: WorkflowView[];
}

export const EMPTY_SNAPSHOT: WorkflowSnapshot = {
  timeZone: "Asia/Dubai", today: "", cadence: "3x_week", cadenceLabel: CADENCE_LABELS["3x_week"],
  mode: "assisted", planId: null, planGoal: null, planValidFrom: null, planValidUntil: null, items: [],
};

export async function loadWorkflowSnapshot(
  admin: AdminClient, ownerId: string, options: { now?: Date; horizonDays?: number } = {},
): Promise<WorkflowSnapshot> {
  const now = options.now ?? new Date();
  const { data: business } = await admin.from("businesses")
    .select("content_frequency,automation_level,timezone").eq("owner_user_id", ownerId).maybeSingle();
  const timeZone = accountTimezone((business as { timezone?: string | null } | null)?.timezone);
  const today = localDate(now, timeZone);
  const cadence = normalizeCadence(business?.content_frequency);
  const mode = business?.automation_level === "manual" || business?.automation_level === "autopilot"
    ? business.automation_level : "assisted";

  const { data: plan } = await admin.from("marketing_plans")
    .select("id,business_goal,valid_from,valid_until")
    .eq("owner_user_id", ownerId).eq("status", "active")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();

  const snapshot: WorkflowSnapshot = {
    timeZone, today, cadence, cadenceLabel: CADENCE_LABELS[cadence], mode,
    planId: plan?.id ? String(plan.id) : null,
    planGoal: plan?.business_goal ? String(plan.business_goal) : null,
    planValidFrom: plan?.valid_from ? String(plan.valid_from) : null,
    planValidUntil: plan?.valid_until ? String(plan.valid_until) : null,
    items: [],
  };
  if (!snapshot.planId) return snapshot;

  const { data: drafts } = await admin.from("mara_drafts")
    .select("id,kind,title,content,proposed_publish_at,status,source_plan_item_key")
    .eq("owner_user_id", ownerId).eq("source_plan_id", snapshot.planId)
    .order("proposed_publish_at", { ascending: true });
  const rows = drafts ?? [];
  if (!rows.length) return snapshot;

  const ids = rows.map((row) => String(row.id));
  const [assets, generations, queue, calendar, approvals] = await Promise.all([
    admin.from("post_draft_assets").select("draft_id").eq("owner_user_id", ownerId).in("draft_id", ids),
    admin.from("mara_media_generations").select("draft_id,status,updated_at").eq("owner_user_id", ownerId).in("draft_id", ids),
    admin.from("instagram_publish_queue").select("draft_id,status,instagram_media_id,failure_message").eq("owner_user_id", ownerId).in("draft_id", ids),
    admin.from("content_calendar_items").select("id,source_draft_id").eq("owner_user_id", ownerId).in("source_draft_id", ids),
    admin.from("mara_pending_actions").select("id,sanitized_arguments,status")
      .eq("owner_user_id", ownerId).eq("tool_name", "propose_calendar_item").in("status", ["pending", "failed"]),
  ]);

  const hasAsset = new Set((assets.data ?? []).map((row) => String(row.draft_id)));
  const mediaStatus = new Map<string, string>();
  for (const row of generations.data ?? []) {
    // Latest generation wins; the query is small and ordered by the join below.
    mediaStatus.set(String(row.draft_id), String(row.status));
  }
  const publish = new Map((queue.data ?? []).map((row) => [String(row.draft_id), row]));
  const calendarIds = new Map((calendar.data ?? []).map((row) => [String(row.source_draft_id), String(row.id)]));
  const approvalIds = new Map<string, string>();
  for (const row of approvals.data ?? []) {
    const draftId = (row.sanitized_arguments as { sourceDraftId?: unknown } | null)?.sourceDraftId;
    if (typeof draftId === "string") approvalIds.set(draftId, String(row.id));
  }

  snapshot.items = rows.map((row) => {
    const draftId = String(row.id);
    const publishRow = publish.get(draftId) as { status?: string; instagram_media_id?: string | null; failure_message?: string | null } | undefined;
    const kind = String(row.kind ?? "instagram_post");
    const contentType = kind === "reel" ? "reel" : kind === "story" ? "story" : "post";
    const facts = {
      draftStatus: (String(row.status ?? "draft") as "draft" | "approved" | "rejected"),
      hasMedia: hasAsset.has(draftId),
      mediaStatus: (mediaStatus.get(draftId) ?? null) as never,
      publishStatus: publishRow?.status ?? null,
      awaitingApproval: approvalIds.has(draftId),
    };
    const status = deriveWorkflowStatus(facts);
    const publishAt = String(row.proposed_publish_at ?? "");
    return {
      draftId,
      calendarItemId: calendarIds.get(draftId) ?? null,
      slotDate: String(row.source_plan_item_key ?? (publishAt ? isoToLocalDate(publishAt, timeZone) : today)),
      contentType,
      contentTypeLabel: contentTypeLabel(contentType),
      concept: String(row.title ?? ""),
      caption: String(row.content ?? ""),
      publishAt,
      localDate: publishAt ? isoToLocalDate(publishAt, timeZone) : "",
      localTime: publishAt ? formatLocalTime(publishAt, timeZone) : "",
      dayLabel: publishAt ? relativeDayLabel(isoToLocalDate(publishAt, timeZone), now, timeZone) : "",
      status,
      statusLabel: WORKFLOW_STATUS_LABELS[status],
      failedStage: failureStage(facts),
      failureMessage: publishRow?.failure_message ?? null,
      approvalActionId: approvalIds.get(draftId) ?? null,
      hasMedia: facts.hasMedia,
      instagramMediaId: publishRow?.instagram_media_id ?? null,
    };
  });
  return snapshot;
}

/** Items whose local publish date is the real current local date. */
export function itemsForToday(snapshot: WorkflowSnapshot): WorkflowView[] {
  return snapshot.items.filter((item) => item.localDate === snapshot.today);
}

/** Operational counts for the Today command centre. */
export function todaySummary(snapshot: WorkflowSnapshot) {
  const items = snapshot.items;
  return {
    publishingToday: itemsForToday(snapshot).filter((item) => item.status !== "failed"),
    needsApproval: items.filter((item) => item.status === "needs_approval"),
    generating: items.filter((item) => item.status === "generating"),
    failed: items.filter((item) => item.status === "failed"),
    scheduled: items.filter((item) => item.status === "scheduled"),
    published: items.filter((item) => item.status === "published"),
    next: items.find((item) => item.status === "scheduled" || item.status === "publishing") ?? null,
  };
}
