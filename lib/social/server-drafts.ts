/**
 * Multi-Social Core — server data layer for TikTok / YouTube drafts.
 *
 * One unified Studio writes three draft families into the SAME `mara_drafts`
 * table: the existing Instagram kinds (Post/Reel/Story, handled by
 * lib/post/server-data) and the social video kinds added by migration 0046
 * (tiktok_video / youtube_short / youtube_video, handled here).
 *
 * Truthfulness rules enforced in this module:
 *   - a social draft can be created, edited, approved and scheduled INSIDE
 *     Voom — and that is all. There is NO TikTok/YouTube publish queue, NO
 *     provider call and NO connection; approval never means publication.
 *   - an approved + scheduled social draft is mirrored to the Content
 *     Calendar (status 'scheduled') so the marketing calendar shows it, but
 *     no cron or worker can execute it — the publisher boundary
 *     (lib/social/publisher) truthfully refuses until real integrations
 *     ship.
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

/** Owner-scoped read of one social draft. */
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
  return toSocialDraftView(row, (asset as Record<string, unknown> | null) ?? null);
}

/** Lists the owner's TikTok/YouTube drafts, newest first. */
export async function listSocialDrafts(admin: AdminClient, ownerId: string): Promise<SocialDraftView[]> {
  const { data } = await admin.from("mara_drafts").select(DRAFT_COLUMNS)
    .eq("owner_user_id", ownerId)
    .in("kind", ["tiktok_video", "youtube_short", "youtube_video"])
    .order("created_at", { ascending: false })
    .limit(50);
  const rows = (data ?? []) as Record<string, unknown>[];
  return Promise.all(rows.map(async (row) => {
    const { data: asset } = await admin.from("post_draft_assets")
      .select("display_name,mime_type").eq("owner_user_id", ownerId).eq("draft_id", String(row.id)).maybeSingle();
    return toSocialDraftView(row, (asset as Record<string, unknown> | null) ?? null);
  }));
}

function toSocialDraftView(row: Record<string, unknown>, asset: Record<string, unknown> | null): SocialDraftView {
  const kind = row.kind as SocialVideoDraftKind;
  const pair = kindPair(kind);
  const meta = (row.content_meta && typeof row.content_meta === "object" ? row.content_meta : {}) as Record<string, unknown>;
  const status = row.status === "approved" ? "approved" : row.status === "rejected" ? "rejected" : "draft";
  const scheduledAt = row.proposed_publish_at ? String(row.proposed_publish_at) : null;
  // Truthful state: an approved item on an unconnected provider is
  // `connection_required` — never scheduled-for-execution, never published.
  const publishState = status === "approved" ? "connection_required" : status === "rejected" ? "blocked" : "draft";
  const publishStateLabel = status === "approved"
    ? "Approved — publishing not connected yet"
    : status === "rejected"
      ? "Rejected"
      : "Draft";
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
    asset: asset ? { displayName: String(asset.display_name ?? ""), mimeType: String(asset.mime_type ?? "") } : null,
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
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
}

/**
 * Edits and/or (un)approves one social draft.
 *
 * Approving mirrors the draft to the Content Calendar as 'scheduled' when it
 * has a future schedule (the one marketing calendar shows every channel);
 * un-approving removes that mirror. No queue row, no provider call — the
 * mirror is presentation, and the publisher boundary remains the only gate
 * to execution.
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

  const meta: Record<string, unknown> = {
    ...(description ? { description } : {}),
    ...(concept ? { concept } : {}),
    script,
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

  return getSocialDraft(admin, ownerId, draftId);
}

/**
 * The ONE marketing calendar shows every channel. TikTok/YouTube items are
 * read straight from the owner's approved + scheduled social drafts and
 * rendered with the business timezone, exactly like the Instagram workflow
 * items. Their state label is truthful: "Approved — publishing not connected
 * yet". No queue, no provider call, no execution.
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

  return rows.map((row) => {
    const kind = row.kind as SocialVideoDraftKind;
    const pair = kindPair(kind);
    const scheduledAt = String(row.proposed_publish_at);
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
      statusLabel: "Approved — publishing not connected yet",
    };
  });
}
