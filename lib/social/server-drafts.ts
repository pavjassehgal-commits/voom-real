/**
 * Multi-Social Core — server data layer for TikTok / YouTube drafts.
 *
 * One unified Studio writes three draft families into the SAME `mara_drafts`
 * table: the existing Instagram kinds (Post/Reel/Story, handled by
 * lib/post/server-data) and the social video kinds added by migration 0046
 * (tiktok_video / youtube_short / youtube_video, handled here).
 *
 * Truthfulness rules enforced in this module:
 *   - approval NEVER means publication, on any channel.
 *   - YouTube is REAL (YouTube Provider Integration v1): approving and
 *     scheduling a YouTube draft mirrors it into the durable
 *     `youtube_publish_queue` (migration 0047) through the SAME idempotent
 *     upsert the publisher boundary uses. Only the cron worker can move a
 *     queue row to published, and only with YouTube's own video id plus
 *     uploadStatus='processed'. This module performs NO Google call.
 *   - TikTok is REAL (TikTok Provider Integration v1): approving and
 *     scheduling a TikTok draft mirrors it into the durable
 *     `tiktok_publish_queue` (migration 0049) through the same idempotent
 *     upsert. Only the cron worker can move a queue row to published, and
 *     only with TikTok's own PUBLISH_COMPLETE post status. This module
 *     performs NO TikTok call.
 *   - the view and calendar labels are QUEUE-DRIVEN for both: an item reads
 *     scheduled / uploading / processing / published / failed exactly as the
 *     durable queue says — never optimistic, never invented.
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
import { publishStateFromTikTokQueue, publishStateFromYouTubeQueue, type SocialPublishState } from "@/lib/social/publish-state";
import {
  cancelTikTokPublishItem,
  enqueueTikTokPublishItem,
  getTikTokQueueItemForDraft,
  getTikTokQueueItemsForDrafts,
  type TikTokQueueRow,
} from "@/lib/tiktok/publish-queue";
import { isTikTokPrivacy } from "@/lib/tiktok/publishing";
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
  "id,conversation_id,kind,channel,title,content,proposed_publish_at,status,social_channel,social_format,content_meta,provider_ref,source_plan_id,source_plan_item_key,created_at,updated_at";

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
  /**
   * Explicit TikTok privacy choice (TikTok's own four values), or null when
   * not yet declared. TikTok has NO default privacy level, so null is a real,
   * visible state that parks the queue row in `needs_declaration`.
   */
  tiktokPrivacy: string | null;
  /** The durable provider queue state, when a queue row exists. */
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

function isProviderOwnedSocialQueue(channel: "tiktok" | "youtube", status: string | null): boolean {
  return channel === "youtube"
    ? status === "uploading" || status === "provider_processing" || status === "published"
    : status === "posting" || status === "provider_processing" || status === "published";
}

export interface CreateSocialDraftInput {
  kind: SocialVideoDraftKind;
  title: string;
  caption?: string;
  description?: string;
  concept?: string;
  hook?: string;
  cta?: string;
  hashtags?: string[];
  productionGuidance?: string;
  script?: string[];
  scheduledAt?: string | null;
  /** Stable plan identity for server-generated rolling-plan drafts. */
  planSource?: { planId: string; slotKey: string };
  /** Explicit YouTube declarations (policy-sensitive; never defaulted here). */
  madeForKids?: boolean | null;
  privacy?: "public" | "private" | "unlisted" | null;
  /** Explicit TikTok privacy declaration (policy-sensitive; never defaulted here). */
  tiktokPrivacy?: string | null;
}

/** Creates one TikTok/YouTube planning draft. Rolling-plan writes are idempotent. */
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
  const hashtags = Array.isArray(input.hashtags)
    ? input.hashtags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim().replace(/^#+/, "").slice(0, 80)).filter(Boolean).slice(0, 15)
    : [];
  const meta: Record<string, unknown> = {
    ...(input.description?.trim() ? { description: input.description.trim().slice(0, 5000) } : {}),
    ...(input.concept?.trim() ? { concept: input.concept.trim().slice(0, 300) } : {}),
    ...(input.hook?.trim() ? { hook: input.hook.trim().slice(0, 500) } : {}),
    ...(input.cta?.trim() ? { cta: input.cta.trim().slice(0, 500) } : {}),
    ...(hashtags.length ? { hashtags } : {}),
    ...(input.productionGuidance?.trim() ? { productionGuidance: input.productionGuidance.trim().slice(0, 1000) } : {}),
    script: Array.isArray(input.script)
      ? input.script.filter((line): line is string => typeof line === "string").map((line) => line.trim().slice(0, 400)).filter(Boolean).slice(0, 40)
      : [],
    ...(typeof input.madeForKids === "boolean" ? { madeForKids: input.madeForKids } : {}),
    ...(input.privacy === "public" || input.privacy === "private" || input.privacy === "unlisted" ? { privacy: input.privacy } : {}),
    ...(typeof input.tiktokPrivacy === "string" && isTikTokPrivacy(input.tiktokPrivacy) ? { tiktokPrivacy: input.tiktokPrivacy } : {}),
  };
  const row = {
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
    ...(input.planSource ? {
      source_plan_id: input.planSource.planId,
      source_plan_item_key: input.planSource.slotKey,
    } : {}),
  };
  if (!input.planSource) {
    const { data, error } = await admin.from("mara_drafts").insert(row).select("id").single();
    if (error || !data?.id) throw new Error("social_draft_create_failed");
    return String(data.id);
  }

  const { data, error } = await admin.from("mara_drafts")
    .upsert(row, {
      onConflict: "owner_user_id,source_plan_id,source_plan_item_key",
      ignoreDuplicates: true,
    })
    .select("id,kind,social_channel,social_format")
    .maybeSingle();
  if (error && error.code !== "23505") throw new Error("social_draft_create_failed");
  if (data?.id) return String(data.id);

  const { data: existing, error: existingError } = await admin.from("mara_drafts")
    .select("id,kind,social_channel,social_format")
    .eq("owner_user_id", ownerId)
    .eq("source_plan_id", input.planSource.planId)
    .eq("source_plan_item_key", input.planSource.slotKey)
    .maybeSingle();
  if (existingError || !existing?.id
    || existing.kind !== input.kind
    || existing.social_channel !== pair.channel
    || existing.social_format !== pair.format) {
    throw new Error("social_plan_slot_conflict");
  }
  return String(existing.id);
}

/** Owner-scoped read of one social draft (queue-driven for YouTube). */
export async function getSocialDraft(
  admin: AdminClient,
  ownerId: string,
  draftId: string,
): Promise<SocialDraftView | null> {
  const { data, error } = await admin.from("mara_drafts").select(DRAFT_COLUMNS)
    .eq("owner_user_id", ownerId).eq("id", draftId).maybeSingle();
  if (error) throw new Error("social_draft_read_failed");
  if (!data) return null;
  const row = data as Record<string, unknown>;
  if (!isSocialVideoDraftKind(row.kind)) return null;
  const { data: asset, error: assetError } = await admin.from("post_draft_assets")
    .select("display_name,mime_type").eq("owner_user_id", ownerId).eq("draft_id", draftId).maybeSingle();
  if (assetError) throw new Error("social_draft_asset_read_failed");
  const channel = kindPair(row.kind as SocialVideoDraftKind).channel;
  const queue = channel === "youtube"
    ? await getYouTubeQueueItemForDraft(admin, ownerId, draftId)
    : channel === "tiktok"
      ? await getTikTokQueueItemForDraft(admin, ownerId, draftId)
      : null;
  return toSocialDraftView(row, (asset as Record<string, unknown> | null) ?? null, queue);
}

/**
 * Withdraws a TikTok/YouTube draft from its durable provider queue before a
 * campaign RPC is allowed to rewrite the linked action, draft, Calendar, or
 * review state. Cancellation is atomic at the queue RPC; a false/ambiguous
 * result is verified by rereading the row and fails closed.
 */
export async function cancelSocialDraftQueueBeforeContentMutation(
  admin: AdminClient,
  ownerId: string,
  draftId: string,
): Promise<void> {
  const draft = await getSocialDraft(admin, ownerId, draftId);
  if (!draft) throw new Error("social_draft_not_found");
  if (isProviderOwnedSocialQueue(draft.channel, draft.queueStatus)) {
    throw new Error("social_draft_provider_owned");
  }
  if (draft.channel === "youtube") {
    await cancelAndVerifyYouTubeQueue(admin, ownerId, draftId);
  } else {
    await cancelAndVerifyTikTokQueue(admin, ownerId, draftId);
  }
}

/** Lists the owner's TikTok/YouTube drafts, newest first. */
export async function listSocialDrafts(admin: AdminClient, ownerId: string): Promise<SocialDraftView[]> {
  const { data, error } = await admin.from("mara_drafts").select(DRAFT_COLUMNS)
    .eq("owner_user_id", ownerId)
    .in("kind", ["tiktok_video", "youtube_short", "youtube_video"])
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error("social_drafts_read_failed");
  const rows = (data ?? []) as Record<string, unknown>[];
  const youtubeIds = rows
    .filter((row) => kindPair(row.kind as SocialVideoDraftKind).channel === "youtube")
    .map((row) => String(row.id));
  const tiktokIds = rows
    .filter((row) => kindPair(row.kind as SocialVideoDraftKind).channel === "tiktok")
    .map((row) => String(row.id));
  const [youtubeQueues, tiktokQueues] = await Promise.all([
    getYouTubeQueueItemsForDrafts(admin, ownerId, youtubeIds),
    getTikTokQueueItemsForDrafts(admin, ownerId, tiktokIds),
  ]);
  return Promise.all(rows.map(async (row) => {
    const { data: asset, error: assetError } = await admin.from("post_draft_assets")
      .select("display_name,mime_type").eq("owner_user_id", ownerId).eq("draft_id", String(row.id)).maybeSingle();
    if (assetError) throw new Error("social_draft_asset_read_failed");
    const channel = kindPair(row.kind as SocialVideoDraftKind).channel;
    const queue = channel === "youtube"
      ? youtubeQueues.get(String(row.id)) ?? null
      : channel === "tiktok"
        ? tiktokQueues.get(String(row.id)) ?? null
        : null;
    return toSocialDraftView(row, (asset as Record<string, unknown> | null) ?? null, queue);
  }));
}

function toSocialDraftView(row: Record<string, unknown>, asset: Record<string, unknown> | null, queue: YouTubeQueueRow | TikTokQueueRow | null): SocialDraftView {
  const kind = row.kind as SocialVideoDraftKind;
  const pair = kindPair(kind);
  const meta = (row.content_meta && typeof row.content_meta === "object" ? row.content_meta : {}) as Record<string, unknown>;
  const status = row.status === "approved" ? "approved" : row.status === "rejected" ? "rejected" : "draft";
  const scheduledAt = row.proposed_publish_at ? String(row.proposed_publish_at) : null;
  const madeForKids = typeof meta.madeForKids === "boolean" ? meta.madeForKids : null;
  const privacy = meta.privacy === "public" || meta.privacy === "private" || meta.privacy === "unlisted" ? meta.privacy : null;
  const tiktokPrivacy = typeof meta.tiktokPrivacy === "string" && isTikTokPrivacy(meta.tiktokPrivacy) ? meta.tiktokPrivacy : null;

  // Truthful state. Both social video channels read their DURABLE QUEUE: the
  // state the provider machinery really established — scheduled, uploading /
  // posting (submitting), provider_processing, published (only with the
  // provider's own confirmation: YouTube's video id + 'processed', or
  // TikTok's own PUBLISH_COMPLETE), failed, needs-declaration — never an
  // optimistic invention.
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
      publishStateLabel = youTubeQueueLabel(queue!.status, "provider_privacy_status" in queue! ? queue!.provider_privacy_status : null);
    } else {
      publishState = "approved";
      publishStateLabel = scheduledAt
        ? "Approved — queue sync not confirmed"
        : "Approved — add a schedule to queue publishing";
    }
  } else {
    const queueState = queue ? publishStateFromTikTokQueue(queue.status) : null;
    if (queueState && queueState !== "draft") {
      publishState = queueState;
      publishStateLabel = tikTokQueueLabel(queue!.status);
    } else {
      publishState = "approved";
      publishStateLabel = scheduledAt
        ? "Approved — queue sync not confirmed"
        : "Approved — add a schedule to queue publishing";
    }
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
    tiktokPrivacy,
    queueStatus: queue ? String(queue.status) : null,
    queueFailureMessage: queue && queue.failure_message ? String(queue.failure_message) : null,
    asset: asset ? { displayName: String(asset.display_name ?? ""), mimeType: String(asset.mime_type ?? "") } : null,
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

/** The truthful, provider-honest label for one TikTok queue state. */
export function tikTokQueueLabel(queueStatus: string): string {
  switch (queueStatus) {
    case "scheduled": return "Scheduled — publishes through the TikTok queue";
    case "waiting_for_media": return "Waiting for the video file";
    case "needs_declaration": return "Needs a privacy choice (TikTok has no default privacy)";
    case "permission_required": return "TikTok connection needs attention";
    case "posting": return "Uploading to TikTok";
    case "provider_processing": return "TikTok is processing the video";
    case "published": return "Published on TikTok";
    case "failed": return "TikTok publishing failed";
    case "cancelled": return "Cancelled";
    default: return "Queued";
  }
}

/** The truthful, provider-honest label for one YouTube queue state. */
export function youTubeQueueLabel(queueStatus: string, providerPrivacy: string | null): string {
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
  /** Approval transition or campaign rejection. */
  decision?: "approved" | "draft" | "rejected";
  /** Explicit YouTube declarations (policy-sensitive; never defaulted here). */
  madeForKids?: boolean | null;
  privacy?: "public" | "private" | "unlisted" | null;
  /** Explicit TikTok privacy declaration (policy-sensitive; never defaulted here). */
  tiktokPrivacy?: string | null;
}

async function cancelAndVerifyYouTubeQueue(admin: AdminClient, ownerId: string, draftId: string): Promise<void> {
  const before = await getYouTubeQueueItemForDraft(admin, ownerId, draftId);
  if (before && isProviderOwnedSocialQueue("youtube", before.status)) {
    throw new Error("social_draft_provider_owned");
  }
  if (await cancelYouTubePublishItem(admin, ownerId, draftId)) return;
  const remaining = await getYouTubeQueueItemForDraft(admin, ownerId, draftId);
  if (remaining && isProviderOwnedSocialQueue("youtube", remaining.status)) {
    throw new Error("social_draft_provider_owned");
  }
  // A false cancellation is safe only when no queue row existed at the start
  // and none appeared afterward. A vanished previously observed row is ambiguous.
  if (before || remaining) throw new Error("social_draft_queue_cancel_not_confirmed");
}

async function cancelAndVerifyTikTokQueue(admin: AdminClient, ownerId: string, draftId: string): Promise<void> {
  const before = await getTikTokQueueItemForDraft(admin, ownerId, draftId);
  if (before && isProviderOwnedSocialQueue("tiktok", before.status)) {
    throw new Error("social_draft_provider_owned");
  }
  if (await cancelTikTokPublishItem(admin, ownerId, draftId)) return;
  const remaining = await getTikTokQueueItemForDraft(admin, ownerId, draftId);
  if (remaining && isProviderOwnedSocialQueue("tiktok", remaining.status)) {
    throw new Error("social_draft_provider_owned");
  }
  if (before || remaining) throw new Error("social_draft_queue_cancel_not_confirmed");
}

/**
 * Edits and/or (un)approves one social draft.
 *
 * Approving mirrors the draft to the Content Calendar as 'scheduled' when it
 * has a future schedule (the one marketing calendar shows every channel);
 * un-approving removes that mirror.
 *
 * For YOUTUBE drafts it additionally mirrors the decision into the durable
 * `youtube_publish_queue`, and for TIKTOK drafts into the durable
 * `tiktok_publish_queue`, through the same idempotent upsert the publisher
 * boundary uses: approved + scheduled enqueues (or refreshes) ONE queue row
 * per (owner, draft); un-approving, rejecting or removing the schedule
 * cancels it — never a row the provider already owns. This module performs
 * NO provider call: only the cron workers upload, and only each provider's
 * own confirmation (YouTube 'processed' / TikTok PUBLISH_COMPLETE) ever
 * establishes Published.
 */
export interface UpdateSocialDraftOptions {
  /** Trusted server caller already confirmed cancellation before a parent mutation. */
  queueCancellationConfirmed?: boolean;
}

export async function updateSocialDraft(
  admin: AdminClient,
  ownerId: string,
  draftId: string,
  input: UpdateSocialDraftInput,
  options: UpdateSocialDraftOptions = {},
): Promise<SocialDraftView | null> {
  const existing = await getSocialDraft(admin, ownerId, draftId);
  if (!existing) return null;

  if (isProviderOwnedSocialQueue(existing.channel, existing.queueStatus)) {
    throw new Error("social_draft_provider_owned");
  }

  const title = input.title !== undefined ? input.title.trim().slice(0, 160) : existing.title;
  if (!title) throw new Error("social_title_required");
  const caption = input.caption !== undefined ? input.caption.trim().slice(0, 4000) : existing.caption;
  const description = input.description !== undefined ? input.description.trim().slice(0, 5000) : existing.description ?? "";
  const concept = input.concept !== undefined ? input.concept.trim().slice(0, 300) : existing.concept ?? "";
  const script = input.script !== undefined
    ? input.script.filter((line): line is string => typeof line === "string").map((line) => line.trim().slice(0, 400)).filter(Boolean).slice(0, 40)
    : existing.script;
  const scheduledAt = input.scheduledAt !== undefined ? normalizeSchedule(input.scheduledAt) : existing.scheduledAt;
  const status = input.decision === "approved" ? "approved"
    : input.decision === "draft" ? "draft"
      : input.decision === "rejected" ? "rejected" : existing.status;

  // Explicit declarations win; an explicit null CLEARS the declaration back
  // to undeclared (which parks the queue row visibly — never a silent guess).
  const madeForKids = input.madeForKids !== undefined ? input.madeForKids : existing.madeForKids;
  const privacy = input.privacy !== undefined ? input.privacy : existing.privacy;
  const tiktokPrivacy = input.tiktokPrivacy !== undefined
    ? (isTikTokPrivacy(input.tiktokPrivacy) ? input.tiktokPrivacy : null)
    : existing.tiktokPrivacy;

  const meta: Record<string, unknown> = {
    ...(description ? { description } : {}),
    ...(concept ? { concept } : {}),
    script,
    ...(typeof madeForKids === "boolean" ? { madeForKids } : {}),
    ...(privacy ? { privacy } : {}),
    ...(tiktokPrivacy ? { tiktokPrivacy } : {}),
  };

  const needsQueueCancellation = status !== "approved" || !scheduledAt;
  const previouslyConfirmedCancellation = options.queueCancellationConfirmed === true
    && existing.queueStatus === "cancelled";
  if (needsQueueCancellation && !previouslyConfirmedCancellation && existing.channel === "youtube") {
    await cancelAndVerifyYouTubeQueue(admin, ownerId, draftId);
  } else if (needsQueueCancellation && !previouslyConfirmedCancellation && existing.channel === "tiktok") {
    await cancelAndVerifyTikTokQueue(admin, ownerId, draftId);
  }

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
      const { error: calendarError } = await admin.from("content_calendar_items").upsert({
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
      if (calendarError) throw new Error("social_calendar_sync_failed");
    } else {
      const { error: calendarError } = await admin.from("content_calendar_items")
        .delete()
        .eq("owner_user_id", ownerId)
        .eq("source_draft_id", draftId);
      if (calendarError) throw new Error("social_calendar_sync_failed");
    }
  }

  // YouTube execution mirror: the durable publish queue (migration 0047).
  if (existing.channel === "youtube" && !needsQueueCancellation) {
    await syncSocialDraftToYouTubeQueue(admin, ownerId, draftId, {
      status,
      scheduledAt,
      title,
      caption,
      description,
      madeForKids,
      privacy,
      format: existing.format === "short" ? "short" : "video",
    });
  }

  // TikTok execution mirror: the durable provider queue (migration 0049).
  if (existing.channel === "tiktok" && !needsQueueCancellation) {
    await syncSocialDraftToTikTokQueue(admin, ownerId, draftId, {
      status,
      scheduledAt,
      title,
      caption,
      tiktokPrivacy,
    });
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
    await cancelAndVerifyYouTubeQueue(admin, ownerId, draftId);
    return;
  }

  // Owner-level explicit defaults (nullable — no default is a real state).
  const { data: connection, error: connectionError } = await admin.from("youtube_connections")
    .select("default_privacy,default_made_for_kids")
    .eq("owner_user_id", ownerId).maybeSingle();
  if (connectionError) throw new Error("youtube_connection_read_failed");
  const declaration = resolveAudienceDeclaration({
    itemMadeForKids: draft.madeForKids,
    itemPrivacy: draft.privacy,
    defaultMadeForKids: connection && typeof connection.default_made_for_kids === "boolean" ? connection.default_made_for_kids : null,
    defaultPrivacy: connection ? connection.default_privacy as string | null : null,
  });

  const { data: asset, error: assetError } = await admin.from("post_draft_assets")
    .select("id,status").eq("owner_user_id", ownerId).eq("draft_id", draftId).maybeSingle();
  if (assetError) throw new Error("youtube_asset_read_failed");
  const waitingForMedia = !asset || asset.status !== "uploaded";

  const { data: calendar, error: calendarError } = await admin.from("content_calendar_items")
    .select("id").eq("owner_user_id", ownerId).eq("source_draft_id", draftId).maybeSingle();
  if (calendarError) throw new Error("youtube_calendar_read_failed");

  const queued = await enqueueYouTubePublishItem(admin, {
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
  if (!queued || queued.owner_user_id !== ownerId || queued.draft_id !== draftId) {
    throw new Error("youtube_publish_enqueue_failed");
  }
}

/**
 * The ONE place a TikTok draft meets its durable queue row.
 *
 * Rules (mirroring the YouTube sync, with TikTok's own truths):
 *   - approved + scheduled → idempotent upsert (ONE row per owner+draft;
 *     provider-owned rows are returned untouched by the RPC itself);
 *   - anything else → cancel, which the RPC refuses for rows the provider
 *     already owns (posting/processing/published) — history is preserved;
 *   - TikTok has NO default privacy level: the privacy resolves explicit
 *     item value first, then the owner's explicit connection default; an
 *     unresolved choice stays null and the row parks in
 *     `needs_declaration` — Voom never invents a policy-sensitive value.
 *     The live creator-info options TikTok returns still win at publish time
 *     (an unaudited client may be refused even an offered non-private level).
 *   - the post title is the CAPTION (TikTok's own limit: 2200 characters);
 *   - interaction/brand disclosures are not yet surfaced in the UI and are
 *     passed as null (omitted from the request — TikTok's own defaults apply);
 *   - a missing video asset holds the row truthfully in waiting_for_media.
 * This module performs NO TikTok call: only the cron worker uploads, and
 * only TikTok's own PUBLISH_COMPLETE ever establishes Published.
 */
export async function syncSocialDraftToTikTokQueue(
  admin: AdminClient,
  ownerId: string,
  draftId: string,
  draft: {
    status: "draft" | "approved" | "rejected";
    scheduledAt: string | null;
    title: string;
    caption: string;
    tiktokPrivacy: string | null;
  },
): Promise<void> {
  if (draft.status !== "approved" || !draft.scheduledAt) {
    await cancelAndVerifyTikTokQueue(admin, ownerId, draftId);
    return;
  }

  // Owner-level explicit default (nullable — no default is a real state:
  // TikTok has no default privacy level).
  const { data: connection, error: connectionError } = await admin.from("tiktok_connections")
    .select("default_privacy")
    .eq("owner_user_id", ownerId).maybeSingle();
  if (connectionError) throw new Error("tiktok_connection_read_failed");
  const connectionDefault = connection && typeof connection.default_privacy === "string" && isTikTokPrivacy(connection.default_privacy)
    ? connection.default_privacy
    : null;
  const privacy = draft.tiktokPrivacy ?? connectionDefault;

  const { data: asset, error: assetError } = await admin.from("post_draft_assets")
    .select("id,status").eq("owner_user_id", ownerId).eq("draft_id", draftId).maybeSingle();
  if (assetError) throw new Error("tiktok_asset_read_failed");
  const waitingForMedia = !asset || asset.status !== "uploaded";

  const { data: calendar, error: calendarError } = await admin.from("content_calendar_items")
    .select("id").eq("owner_user_id", ownerId).eq("source_draft_id", draftId).maybeSingle();
  if (calendarError) throw new Error("tiktok_calendar_read_failed");

  // The TikTok post title is the caption; TikTok's own limit is 2200 chars.
  const title = draft.caption.trim().slice(0, 2200) || draft.title.trim().slice(0, 2200) || "Untitled";

  const queued = await enqueueTikTokPublishItem(admin, {
    ownerId,
    draftId,
    calendarItemId: calendar ? String(calendar.id) : null,
    title,
    privacyLevel: privacy,
    disableComment: null,
    disableDuet: null,
    disableStitch: null,
    brandContentToggle: null,
    brandOrganicToggle: null,
    isAigc: null,
    scheduledAt: draft.scheduledAt,
    waitingForMedia,
  });
  if (!queued || queued.owner_user_id !== ownerId || queued.draft_id !== draftId) {
    throw new Error("tiktok_publish_enqueue_failed");
  }
}

/**
 * The ONE marketing calendar shows every channel. TikTok/YouTube items are
 * read straight from the owner's approved + scheduled social drafts and
 * rendered with the business timezone, exactly like the Instagram workflow
 * items. TikTok and YouTube labels are QUEUE-DRIVEN (each durable publish
 * queue is the execution truth for its channel). This module makes no
 * provider call.
 */
export interface SocialCalendarItemView {
  draftId: string;
  calendarItemId: string | null;
  kind: SocialVideoDraftKind;
  channel: "tiktok" | "youtube";
  format: "video" | "short";
  contentTypeLabel: string;
  sourceLabel: "Marketing Plan" | "Studio";
  media: { displayName: string; mimeType: string } | null;
  queueStatus: string | null;
  queueFailureMessage: string | null;
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
  const { data: business, error: businessError } = await admin.from("businesses")
    .select("timezone").eq("owner_user_id", ownerId).maybeSingle();
  if (businessError) throw new Error("social_calendar_timezone_read_failed");
  const timeZone = accountTimezone((business as { timezone?: string | null } | null)?.timezone);

  const { data: drafts, error: draftsError } = await admin.from("mara_drafts").select(DRAFT_COLUMNS)
    .eq("owner_user_id", ownerId)
    .in("kind", ["tiktok_video", "youtube_short", "youtube_video"])
    .eq("status", "approved")
    .not("proposed_publish_at", "is", null)
    .order("proposed_publish_at", { ascending: true })
    .limit(100);
  if (draftsError) throw new Error("social_calendar_drafts_read_failed");
  const rows = (drafts ?? []) as Record<string, unknown>[];
  if (!rows.length) return [];

  const ids = rows.map((row) => String(row.id));
  const [calendar, assets] = await Promise.all([
    admin.from("content_calendar_items").select("id,source_draft_id").eq("owner_user_id", ownerId).in("source_draft_id", ids),
    admin.from("post_draft_assets").select("draft_id,display_name,mime_type,status").eq("owner_user_id", ownerId).in("draft_id", ids),
  ]);
  if (calendar.error || assets.error) throw new Error("social_calendar_metadata_read_failed");
  const mirror = new Map((calendar.data ?? []).map((row) => [String(row.source_draft_id), String(row.id)]));
  const assetsByDraft = new Map((assets.data ?? []).map((row) => [String(row.draft_id), row]));

  // TikTok and YouTube calendar items are QUEUE-DRIVEN: each durable publish
  // queue is the truth about execution, so the calendar shows scheduled /
  // uploading / processing / published exactly as the queue says.
  const youtubeIds = rows
    .filter((row) => kindPair(row.kind as SocialVideoDraftKind).channel === "youtube")
    .map((row) => String(row.id));
  const tiktokIds = rows
    .filter((row) => kindPair(row.kind as SocialVideoDraftKind).channel === "tiktok")
    .map((row) => String(row.id));
  const [youtubeQueueByDraft, tiktokQueueByDraft] = await Promise.all([
    getYouTubeQueueItemsForDrafts(admin, ownerId, youtubeIds),
    getTikTokQueueItemsForDrafts(admin, ownerId, tiktokIds),
  ]);

  return rows.map((row) => {
    const kind = row.kind as SocialVideoDraftKind;
    const pair = kindPair(kind);
    const scheduledAt = String(row.proposed_publish_at);
    const queue = pair.channel === "youtube"
      ? youtubeQueueByDraft.get(String(row.id)) ?? null
      : pair.channel === "tiktok"
        ? tiktokQueueByDraft.get(String(row.id)) ?? null
        : null;
    const statusLabel = queue
      ? pair.channel === "youtube"
        ? youTubeQueueLabel(queue.status, "provider_privacy_status" in queue ? queue.provider_privacy_status : null)
        : tikTokQueueLabel(queue.status)
      : "Approved — queue sync not confirmed";
    return {
      draftId: String(row.id),
      calendarItemId: mirror.get(String(row.id)) ?? null,
      kind,
      channel: pair.channel,
      format: pair.format,
      contentTypeLabel: SOCIAL_VIDEO_TYPE_LABELS[kind],
      sourceLabel: row.source_plan_id ? "Marketing Plan" : "Studio",
      media: (() => {
        const asset = assetsByDraft.get(String(row.id));
        return asset && asset.status === "uploaded"
          ? { displayName: String(asset.display_name ?? "Video file"), mimeType: String(asset.mime_type ?? "application/octet-stream") }
          : null;
      })(),
      queueStatus: queue?.status ?? null,
      queueFailureMessage: queue?.failure_message ? String(queue.failure_message) : null,
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
