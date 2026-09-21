/**
 * Multi-Social Core — server data layer for TikTok / YouTube drafts.
 *
 * One unified Studio writes three draft families into the SAME `mara_drafts`
 * table: the existing Instagram kinds (Post/Reel/Story, handled by
 * lib/post/server-data) and the social video kinds added by migration 0046
 * (tiktok_video / youtube_short / youtube_video, handled here).
 *
 * Truthfulness rules enforced in this module:
 *   - approval NEVER means publication, on any channel. For TikTok there is
 *     no publish queue, no provider call and no connection at all.
 *   - YouTube is REAL (YouTube Provider Integration v1): approving and
 *     scheduling a YouTube draft mirrors it into the durable
 *     `youtube_publish_queue` (migration 0047) through the SAME idempotent
 *     upsert the publisher boundary uses. Only the cron worker can move a
 *     queue row to published, and only with YouTube's own video id plus
 *     uploadStatus='processed'. This module performs NO Google call.
 *   - the view and calendar labels are QUEUE-DRIVEN for YouTube: an item
 *     reads scheduled / uploading / processing / published / failed exactly
 *     as the durable queue says — never optimistic, never invented.
 *   - policy-sensitive metadata (privacy, made-for-kids) is never guessed:
 *     unresolved declarations park the queue row in `needs_declaration`.
 *   - video assets reuse the existing private `post_draft_assets` storage
 *     (bytes stored once; per-channel metadata stays distinct on the draft).
 *   - owner isolation on every read and write; tokens never exist here.
 *
 * Planning these drafts never spends a credit and never generates media.
 */

import "server-only";

import { ensureStudioConversation } from "@/lib/post/server-data";
import { normalizeSchedule } from "@/lib/post/core";
import {
  isSocialVideoDraftKind,
  socialCalendarChannelFor,
  SOCIAL_VIDEO_TYPE_LABELS,
  type SocialVideoDraftKind,
} from "@/lib/post/core";
import { accountTimezone, formatLocalTime, isoToLocalDate, relativeDayLabel } from "@/lib/voom/timezone";
import { publishStateFromYouTubeQueue, type SocialPublishState } from "@/lib/social/publish-state";
import {
  cancelYouTubePublishItem,
  enqueueYouTubePublishItem,
  getYouTubeQueueItemForDraft,
  getYouTubeQueueItemsForDrafts,
  type YouTubeQueueRow,
} from "@/lib/youtube/publish-queue";
import { resolveAudienceDeclaration } from "@/lib/youtube/publishing";
import type { createAdminClient } from "@/utils/supabase/admin";

export type AdminClient = ReturnType<typeof createAdminClient>;

const DRAFT_COLUMNS =
  "id,conversation_id,kind,channel,title,content,proposed_publish_at,status,social_channel,social_format,content_meta,provider_ref,created_at,updated_at";

export interface SocialDraftView {
  id: string;
  kind: SocialVideoDraftKind;
  typeLabel: string;
  channel: "tiktok" | "youtube";
  format: "video" | "short";
  title: string;
  caption: string;
  description: string | null;
  concept: string | null;
  script: string[];
  status: "draft" | "approved" | "rejected";
  scheduledAt: string | null;
  /** Canonical lifecycle state from lib/social/publish-state. */
  publishState: string;
  publishStateLabel: string;
  providerRef: string | null;
  /** Explicit COPPA declaration, or null when not yet declared. */
  madeForKids: boolean | null;
  /** Explicit privacy choice, or null when not yet declared. */
  privacy: "public" | "private" | "unlisted" | null;
  /** The durable YouTube queue state (YouTube drafts only), when a row exists. */
  queueStatus: string | null;
  /** The queue's truthful failure message, when it carries one. */
  queueFailureMessage: string | null;
  asset: { displayName: string; mimeType: string } | null;
  createdAt: string;
  updatedAt: string;
}

function kindPair(kind: SocialVideoDraftKind): { channel: "tiktok" | "youtube"; format: "video" | "short" } {
  if (kind === "tiktok_video") return { channel: "tiktok", format: "video" };
  if (kind === "youtube_short") return { channel: "youtube", format: "short" };
  return { channel: "youtube", format: "video" };
}

export interface CreateSocialDraftInput {
  kind: SocialVideoDraftKind;
  title: string;
  caption?: string;
  description?: string;
  concept?: string;
  script?: string[];
  scheduledAt?: string | null;
  /** Explicit YouTube declarations (policy-sensitive; never defaulted here). */
  madeForKids?: boolean | null;
  privacy?: "public" | "private" | "unlisted" | null;
}

/** Creates one TikTok/YouTube planning draft. Inserts only. */
export async function createSocialDraft(
  admin: AdminClient,
  ownerId: string,
  input: CreateSocialDraftInput,
): Promise<string> {
  if (!isSocialVideoDraftKind(input.kind)) throw new Error("social_kind_invalid");
  const pair = kindPair(input.kind);
  const conversationId = await ensureStudioConversation(admin, ownerId);
  const title = input.title.trim().slice(0, 160);
  if (!title) throw new Error("social_title_required");
  const caption = (input.caption ?? "").trim().slice(0, 4000);
  const meta: Record<string, unknown> = {
    ...(input.description?.trim() ? { description: input.description.trim().slice(0, 5000) } : {}),
    ...(input.concept?.trim() ? { concept: input.concept.trim().slice(0, 300) } : {}),
    script: Array.isArray(input.script)
      ? input.script.filter((line): line is string => typeof line === "string").map((line) => line.trim().slice(0, 400)).filter(Boolean).slice(0, 40)
      : [],
    ...(typeof input.madeForKids === "boolean" ? { madeForKids: input.madeForKids } : {}),
    ...(input.privacy === "public" || input.privacy === "private" || input.privacy === "unlisted" ? { privacy: input.privacy } : {}),
  };
  const { data, error } = await admin.from("mara_drafts").insert({
    conversation_id: conversationId,
    owner_user_id: ownerId,
    kind: input.kind,
    // The free-form channel label keeps the Studio's existing display pattern.
    channel: input.kind === "tiktok_video"
      ? "TikTok · 9:16"
      : input.kind === "youtube_short"
        ? "YouTube Short · 9:16"
        : "YouTube Video · 16:9",
    title,
    // mara_drafts.content is NOT NULL: the caption, or the title until one exists.
    content: caption || title,
    proposed_publish_at: input.scheduledAt ?? null,
    status: "draft",
    social_channel: pair.channel,
    social_format: pair.format,
    content_meta: meta,
  }).select("id").single();
  if (error || !data?.id) throw new Error("social_draft_create_failed");
  return String(data.id);
}

/** Owner-scoped read of one social draft (queue-driven for YouTube). */
export async function getSocialDraft(
  admin: AdminClient,
  ownerId: string,
  draftId: string,
): Promise<SocialDraftView | null> {
  const { data } = await admin.from("mara_drafts").select(DRAFT_COLUMNS)
    .eq("owner_user_id", ownerId).eq("id", draftId).maybeSingle();
  if (!data) return null;
  const row = data as Record<string, unknown>;
  if (!isSocialVideoDraftKind(row.kind)) return null;
  const { data: asset } = await admin.from("post_draft_assets")
    .select("display_name,mime_type").eq("owner_user_id", ownerId).eq("draft_id", draftId).maybeSingle();
  const queue = kindPair(row.kind as SocialVideoDraftKind).channel === "youtube"
    ? await getYouTubeQueueItemForDraft(admin, ownerId, draftId).catch(() => null)
    : null;
  return toSocialDraftView(row, (asset as Record<string, unknown> | null) ?? null, queue);
}

/** Lists the owner's TikTok/YouTube drafts, newest first. */
export async function listSocialDrafts(admin: AdminClient, ownerId: string): Promise<SocialDraftView[]> {
  const { data } = await admin.from("mara_drafts").select(DRAFT_COLUMNS)
    .eq("owner_user_id", ownerId)
    .in("kind", ["tiktok_video", "youtube_short", "youtube_video"])
    .order("created_at", { ascending: false })
    .limit(50);
  const rows = (data ?? []) as Record<string, unknown>[];
  const youtubeIds = rows
    .filter((row) => kindPair(row.kind as SocialVideoDraftKind).channel === "youtube")
    .map((row) => String(row.id));
  const queueByDraft = await getYouTubeQueueItemsForDrafts(admin, ownerId, youtubeIds).catch(() => new Map<string, YouTubeQueueRow>());
  return Promise.all(rows.map(async (row) => {
    const { data: asset } = await admin.from("post_draft_assets")
      .select("display_name,mime_type").eq("owner_user_id", ownerId).eq("draft_id", String(row.id)).maybeSingle();
    return toSocialDraftView(row, (asset as Record<string, unknown> | null) ?? null, queueByDraft.get(String(row.id)) ?? null);
  }));
}

function toSocialDraftView(row: Record<string, unknown>, asset: Record<string, unknown> | null, queue: YouTubeQueueRow | null): SocialDraftView {
  const kind = row.kind as SocialVideoDraftKind;
  const pair = kindPair(kind);
  const meta = (row.content_meta && typeof row.content_meta === "object" ? row.content_meta : {}) as Record<string, unknown>;
  const status = row.status === "approved" ? "approved" : row.status === "rejected" ? "rejected" : "draft";
  const scheduledAt = row.proposed_publish_at ? String(row.proposed_publish_at) : null;
  const madeForKids = typeof meta.madeForKids === "boolean" ? meta.madeForKids : null;
  const privacy = meta.privacy === "public" || meta.privacy === "private" || meta.privacy === "unlisted" ? meta.privacy : null;

  // Truthful state. TikTok has no provider integration: an approved item is
  // `connection_required`, never scheduled-for-execution, never published.
  // YouTube reads its DURABLE QUEUE: the state the provider machinery really
  // established — scheduled, uploading (submitting), provider_processing,
  // published (only with YouTube's own video id + 'processed' evidence),
  // failed, needs-declaration — never an optimistic invention.
  let publishState: SocialPublishState;
  let publishStateLabel: string;
  if (status === "rejected") {
    publishState = "blocked";
    publishStateLabel = "Rejected";
  } else if (status !== "approved") {
    publishState = "draft";
    publishStateLabel = "Draft";
  } else if (pair.channel === "youtube") {
    const queueState = queue ? publishStateFromYouTubeQueue(queue.status) : null;
    if (queueState && queueState !== "draft") {
      publishState = queueState;
      publishStateLabel = youTubeQueueLabel(queue!.status, queue!.provider_privacy_status);
    } else {
      publishState = "approved";
      publishStateLabel = scheduledAt
        ? "Approved — waiting to be queued"
        : "Approved — add a schedule to queue publishing";
    }
  } else {
    publishState = "connection_required";
    publishStateLabel = "Approved — publishing not connected yet";
  }

  return {
    id: String(row.id),
    kind,
    typeLabel: SOCIAL_VIDEO_TYPE_LABELS[kind],
    channel: pair.channel,
    format: pair.format,
    title: String(row.title ?? ""),
    caption: String(row.content ?? ""),
    description: typeof meta.description === "string" ? meta.description : null,
    concept: typeof meta.concept === "string" ? meta.concept : null,
    script: Array.isArray(meta.script) ? meta.script.filter((line): line is string => typeof line === "string") : [],
    status,
    scheduledAt,
    publishState,
    publishStateLabel,
    // A provider reference only exists when a provider really returned one.
    providerRef: typeof row.provider_ref === "string" && row.provider_ref ? row.provider_ref : null,
    madeForKids,
    privacy,
    queueStatus: queue ? String(queue.status) : null,
    queueFailureMessage: queue && queue.failure_message ? String(queue.failure_message) : null,
    asset: asset ? { displayName: String(asset.display_name ?? ""), mimeType: String(asset.mime_type ?? "") } : null,
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

/** The truthful, provider-honest label for one YouTube queue state. */
function youTubeQueueLabel(queueStatus: string, providerPrivacy: string | null): string {
  switch (queueStatus) {
    case "scheduled": return "Scheduled — publishes through the YouTube queue";
    case "waiting_for_media": return "Waiting for the video file";
    case "needs_declaration": return "Needs audience + privacy declaration";
    case "permission_required": return "YouTube connection needs attention";
    case "uploading": return "Uploading to YouTube";
    case "provider_processing": return "YouTube is processing the video";
    case "published":
      return providerPrivacy === "private"
        ? "Published on YouTube (private — see the connection's audit note)"
        : "Published on YouTube";
    case "failed": return "YouTube publishing failed";
    case "cancelled": return "Cancelled";
    default: return "Queued";
  }
}

export interface UpdateSocialDraftInput {
  title?: string;
  caption?: string;
  description?: string;
  concept?: string;
  script?: string[];
  scheduledAt?: string | null;
  /** Approval transition: 'approved' or back to 'draft'. */
  decision?: "approved" | "draft";
  /** Explicit YouTube declarations (policy-sensitive; never defaulted here). */
  madeForKids?: boolean | null;
  privacy?: "public" | "private" | "unlisted" | null;
}

/**
 * Edits and/or (un)approves one social draft.
 *
 * Approving mirrors the draft to the Content Calendar as 'scheduled' when it
 * has a future schedule (the one marketing calendar shows every channel);
 * un-approving removes that mirror.
 *
 * For YOUTUBE drafts it additionally mirrors the decision into the durable
 * `youtube_publish_queue` through the same idempotent upsert the publisher
 * boundary uses: approved + scheduled enqueues (or refreshes) ONE queue row
 * per (owner, draft); un-approving, rejecting or removing the schedule
 * cancels it — never a row the provider already owns. This module performs
 * NO Google call: only the cron worker uploads, and only YouTube's own
 * confirmation ever establishes Published. TikTok keeps the truthful
 * no-execution path.
 */
export async function updateSocialDraft(
  admin: AdminClient,
  ownerId: string,
  draftId: string,
  input: UpdateSocialDraftInput,
): Promise<SocialDraftView | null> {
  const existing = await getSocialDraft(admin, ownerId, draftId);
  if (!existing) return null;

  const title = input.title !== undefined ? input.title.trim().slice(0, 160) : existing.title;
  if (!title) throw new Error("social_title_required");
  const caption = input.caption !== undefined ? input.caption.trim().slice(0, 4000) : existing.caption;
  const description = input.description !== undefined ? input.description.trim().slice(0, 5000) : existing.description ?? "";
  const concept = input.concept !== undefined ? input.concept.trim().slice(0, 300) : existing.concept ?? "";
  const script = input.script !== undefined
    ? input.script.filter((line): line is string => typeof line === "string").map((line) => line.trim().slice(0, 400)).filter(Boolean).slice(0, 40)
    : existing.script;
  const scheduledAt = input.scheduledAt !== undefined ? normalizeSchedule(input.scheduledAt) : existing.scheduledAt;
  const status = input.decision === "approved" ? "approved" : input.decision === "draft" ? "draft" : existing.status;

  // Explicit declarations win; an explicit null CLEARS the declaration back
  // to undeclared (which parks the queue row visibly — never a silent guess).
  const madeForKids = input.madeForKids !== undefined ? input.madeForKids : existing.madeForKids;
  const privacy = input.privacy !== undefined ? input.privacy : existing.privacy;

  const meta: Record<string, unknown> = {
    ...(description ? { description } : {}),
    ...(concept ? { concept } : {}),
    script,
    ...(typeof madeForKids === "boolean" ? { madeForKids } : {}),
    ...(privacy ? { privacy } : {}),
  };

  const { error } = await admin.from("mara_drafts").update({
    title,
    content: caption || title,
    proposed_publish_at: scheduledAt,
    status,
    content_meta: meta,
  }).eq("owner_user_id", ownerId).eq("id", draftId);
  if (error) throw new Error("social_draft_update_failed");

  // Calendar mirror: approved + scheduled shows on the one marketing
  // calendar; anything else removes the mirror.
  const calendarChannel = socialCalendarChannelFor(existing.kind);
  if (calendarChannel) {
    if (status === "approved" && scheduledAt) {
      await admin.from("content_calendar_items").upsert({
        owner_user_id: ownerId,
        title,
        channel: calendarChannel,
        content: caption || title,
        topic: concept.slice(0, 500),
        publish_at: scheduledAt,
        status: "scheduled",
        source_draft_id: draftId,
        social_channel: existing.channel,
        social_format: existing.format,
      }, { onConflict: "owner_user_id,source_draft_id" });
    } else {
      await admin.from("content_calendar_items")
        .delete()
        .eq("owner_user_id", ownerId)
        .eq("source_draft_id", draftId);
    }
  }

  // YouTube execution mirror: the durable publish queue (migration 0047).
  if (existing.channel === "youtube") {
    await syncSocialDraftToYouTubeQueue(admin, ownerId, draftId, {
      status,
      scheduledAt,
      title,
      caption,
      description,
      madeForKids,
      privacy,
      format: existing.format === "short" ? "short" : "video",
    }).catch(() => undefined);
  }

  return getSocialDraft(admin, ownerId, draftId);
}

/**
 * The ONE place a YouTube draft meets its durable queue row.
 *
 * Rules:
 *   - approved + scheduled → idempotent upsert (ONE row per owner+draft;
 *     provider-owned rows are returned untouched by the RPC itself);
 *   - anything else → cancel, which the RPC refuses for rows the provider
 *     already owns (uploading/processing/published) — history is preserved;
 *   - declarations resolve explicit item values first, then the owner's
 *     explicit connection defaults; unresolved stays null and the row parks
 *     in `needs_declaration` instead of guessing policy-sensitive metadata;
 *   - a missing video asset holds the row truthfully in waiting_for_media.
 */
export async function syncSocialDraftToYouTubeQueue(
  admin: AdminClient,
  ownerId: string,
  draftId: string,
  draft: {
    status: "draft" | "approved" | "rejected";
    scheduledAt: string | null;
    title: string;
    caption: string;
    description: string;
    madeForKids: boolean | null;
    privacy: "public" | "private" | "unlisted" | null;
    format: "short" | "video";
  },
): Promise<void> {
  if (draft.status !== "approved" || !draft.scheduledAt) {
    try { await cancelYouTubePublishItem(admin, ownerId, draftId); } catch { /* best effort */ }
    return;
  }

  // Owner-level explicit defaults (nullable — no default is a real state).
  const { data: connection } = await admin.from("youtube_connections")
    .select("default_privacy,default_made_for_kids")
    .eq("owner_user_id", ownerId).maybeSingle();
  const declaration = resolveAudienceDeclaration({
    itemMadeForKids: draft.madeForKids,
    itemPrivacy: draft.privacy,
    defaultMadeForKids: connection && typeof connection.default_made_for_kids === "boolean" ? connection.default_made_for_kids : null,
    defaultPrivacy: connection ? connection.default_privacy as string | null : null,
  });

  const { data: asset } = await admin.from("post_draft_assets")
    .select("id,status").eq("owner_user_id", ownerId).eq("draft_id", draftId).maybeSingle();
  const waitingForMedia = !asset || asset.status !== "uploaded";

  const { data: calendar } = await admin.from("content_calendar_items")
    .select("id").eq("owner_user_id", ownerId).eq("source_draft_id", draftId).maybeSingle();

  await enqueueYouTubePublishItem(admin, {
    ownerId,
    draftId,
    calendarItemId: calendar ? String(calendar.id) : null,
    youtubeFormat: draft.format,
    // YouTube's own hard limit is 100 characters; the RPC refuses longer.
    title: draft.title.trim().slice(0, 100) || draft.caption.trim().slice(0, 100) || "Untitled",
    description: (draft.description || draft.caption).slice(0, 5000),
    privacyStatus: declaration.ok ? declaration.privacy : null,
    madeForKids: declaration.ok ? declaration.madeForKids : null,
    scheduledAt: draft.scheduledAt,
    waitingForMedia,
  });
}

/**
 * The ONE marketing calendar shows every channel. TikTok/YouTube items are
 * read straight from the owner's approved + scheduled social drafts and
 * rendered with the business timezone, exactly like the Instagram workflow
 * items. YouTube labels are QUEUE-DRIVEN (the durable publish queue is the
 * execution truth); TikTok keeps the truthful "publishing not connected yet"
 * label. This module makes no provider call.
 */
export interface SocialCalendarItemView {
  draftId: string;
  calendarItemId: string | null;
  kind: SocialVideoDraftKind;
  channel: "tiktok" | "youtube";
  contentTypeLabel: string;
  concept: string;
  caption: string;
  scheduledAt: string;
  localDate: string;
  localTime: string;
  dayLabel: string;
  statusLabel: string;
}

export async function listSocialCalendarItems(
  admin: AdminClient, ownerId: string, now: Date = new Date(),
): Promise<SocialCalendarItemView[]> {
  const { data: business } = await admin.from("businesses")
    .select("timezone").eq("owner_user_id", ownerId).maybeSingle();
  const timeZone = accountTimezone((business as { timezone?: string | null } | null)?.timezone);

  const { data: drafts } = await admin.from("mara_drafts").select(DRAFT_COLUMNS)
    .eq("owner_user_id", ownerId)
    .in("kind", ["tiktok_video", "youtube_short", "youtube_video"])
    .eq("status", "approved")
    .not("proposed_publish_at", "is", null)
    .order("proposed_publish_at", { ascending: true })
    .limit(100);
  const rows = (drafts ?? []) as Record<string, unknown>[];
  if (!rows.length) return [];

  const ids = rows.map((row) => String(row.id));
  const { data: calendar } = await admin.from("content_calendar_items")
    .select("id,source_draft_id").eq("owner_user_id", ownerId).in("source_draft_id", ids);
  const mirror = new Map((calendar ?? []).map((row) => [String(row.source_draft_id), String(row.id)]));

  // YouTube calendar items are QUEUE-DRIVEN: the durable publish queue is the
  // truth about execution, so the calendar shows scheduled / uploading /
  // processing / published exactly as the queue says. TikTok items keep the
  // truthful planning-only label — no TikTok execution machinery exists.
  const youtubeIds = rows
    .filter((row) => kindPair(row.kind as SocialVideoDraftKind).channel === "youtube")
    .map((row) => String(row.id));
  const queueByDraft = await getYouTubeQueueItemsForDrafts(admin, ownerId, youtubeIds)
    .catch(() => new Map<string, YouTubeQueueRow>());

  return rows.map((row) => {
    const kind = row.kind as SocialVideoDraftKind;
    const pair = kindPair(kind);
    const scheduledAt = String(row.proposed_publish_at);
    const queue = pair.channel === "youtube" ? queueByDraft.get(String(row.id)) ?? null : null;
    const statusLabel = pair.channel === "youtube"
      ? queue
        ? youTubeQueueLabel(queue.status, queue.provider_privacy_status)
        : "Approved — waiting to be queued"
      : "Approved — publishing not connected yet";
    return {
      draftId: String(row.id),
      calendarItemId: mirror.get(String(row.id)) ?? null,
      kind,
      channel: pair.channel,
      contentTypeLabel: SOCIAL_VIDEO_TYPE_LABELS[kind],
      concept: String(row.title ?? ""),
      caption: String(row.content ?? ""),
      scheduledAt,
      localDate: isoToLocalDate(scheduledAt, timeZone),
      localTime: formatLocalTime(scheduledAt, timeZone),
      dayLabel: relativeDayLabel(isoToLocalDate(scheduledAt, timeZone), now, timeZone),
      statusLabel,
    };
  });
}
