import "server-only";

import { createHash } from "node:crypto";
import { IngestionFailure, type IngestionStage, logIngestionStage, type IngestionLogContext } from "@/lib/media/ingestion-error";
import type { createAdminClient } from "@/utils/supabase/admin";
import {
  buildPostDraftAssetWrite, calendarChannelFor, calendarStatusFor, composePostCaption, decodeDraftFormat,
  encodeDraftChannel, formatForKind, internalPostState, isPostDraftKind, originForAsset, postTypeLabel,
  splitPostCaption, type PostDraftKind, type PostFormat, type PostInternalState, type PostOrigin,
  POST_STATE_LABELS,
} from "./core";
import { persistUploadedPostAsset, PostAssetPersistError } from "./asset-persist";
import { cancelPublishItem, enqueuePublishItem } from "@/lib/instagram/publish-queue";
import { isPublishableMime, publishMediaKindForMime, truncateCaption } from "@/lib/instagram/publishing";

export const POST_ASSET_BUCKET = "mara-media";
/** Short-lived signed previews; storage_path itself never leaves the server. */
export const POST_ASSET_SIGNED_TTL_SECONDS = 600;
export const POST_STUDIO_CONVERSATION_TITLE = "Instagram Post Studio";

const POST_ASSET_TABLE = "post_draft_assets";
const DRAFT_COLUMNS = "id,conversation_id,message_id,kind,channel,title,content,proposed_publish_at,status,created_at,updated_at";
// Production 0021 has no `format` column. Never select it.
const ASSET_COLUMNS = "id,draft_id,display_name,mime_type,byte_size,origin,status,created_at,updated_at,storage_path";

export type AdminClient = ReturnType<typeof createAdminClient>;

export interface PostVisualView {
  displayName: string;
  mimeType: string;
  byteSize: number;
  format: PostFormat;
  origin: PostOrigin;
  /** Short-lived signed URL minted server-side. Null until Voom owns the bytes. */
  previewUrl: string | null;
  updatedAt: string;
}

export interface PostView {
  id: string;
  conversationId: string;
  kind: PostDraftKind;
  typeLabel: string;
  concept: string;
  caption: string;
  cta: string;
  hashtags: string[];
  composedCaption: string;
  format: PostFormat;
  origin: PostOrigin;
  originLabel: string;
  status: "draft" | "approved" | "rejected";
  internalState: PostInternalState;
  internalStateLabel: string;
  scheduledAt: string | null;
  visual: PostVisualView | null;
  /** True only once the bytes are stored privately in Voom. */
  visualReady: boolean;
  calendarItemId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const ORIGIN_LABELS: Record<PostOrigin, string> = {
  mara: "Create with MARA",
  own_asset: "Use my own asset",
  existing_content: "Existing content",
};

/** Creates (once) or reuses the audit conversation Post Studio drafts live in. */
export async function ensureStudioConversation(admin: AdminClient, ownerId: string): Promise<string> {
  const { data: existing } = await admin.from("mara_conversations")
    .select("id").eq("owner_user_id", ownerId).eq("title", POST_STUDIO_CONVERSATION_TITLE).limit(1).maybeSingle();
  if (existing?.id) return String(existing.id);
  const { data: created, error } = await admin.from("mara_conversations")
    .insert({ owner_user_id: ownerId, title: POST_STUDIO_CONVERSATION_TITLE }).select("id").single();
  if (error || !created?.id) throw new Error("post_conversation_failed");
  return String(created.id);
}

export interface CreatePostInput {
  kind: PostDraftKind;
  origin: PostOrigin;
  concept: string;
  caption?: string;
  cta?: string;
  hashtags?: string[];
  format?: PostFormat;
  scheduledAt?: string | null;
}

export async function createPostDraft(admin: AdminClient, ownerId: string, input: CreatePostInput): Promise<string> {
  if (!isPostDraftKind(input.kind)) throw new Error("post_kind_invalid");
  const conversationId = await ensureStudioConversation(admin, ownerId);
  const caption = composePostCaption({ caption: input.caption ?? "", cta: input.cta, hashtags: input.hashtags });
  // Stories are always 9:16; 9:16 never sticks to a feed post.
  const format = formatForKind(input.kind, normalizeFormatInput(input.format));
  const { data, error } = await admin.from("mara_drafts").insert({
    conversation_id: conversationId,
    owner_user_id: ownerId,
    kind: input.kind,
    // The selected format is encoded here so it survives even when no visual
    // exists yet. mara_drafts has no JSON column and no free metadata column.
    channel: encodeDraftChannel(input.kind, format),
    title: input.concept.trim().slice(0, 160),
    // mara_drafts.content is NOT NULL and must be at least one character, so a
    // caption-less post is stored with its concept until the user writes one.
    content: (caption || input.concept.trim()).slice(0, 12000),
    proposed_publish_at: input.scheduledAt ?? null,
    status: "draft",
  }).select("id").single();
  if (error || !data?.id) throw new Error("post_create_failed");
  return String(data.id);
}

export interface PostDraftRow extends Record<string, unknown> { id: string }

async function loadAssetRow(admin: AdminClient, ownerId: string, draftId: string) {
  const { data } = await admin.from(POST_ASSET_TABLE).select(ASSET_COLUMNS)
    .eq("owner_user_id", ownerId).eq("draft_id", draftId).maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}

/** Owner-scoped read of one post plus its private visual. */
export async function getPostDraft(admin: AdminClient, ownerId: string, draftId: string): Promise<PostView | null> {
  const { data: draft } = await admin.from("mara_drafts").select(DRAFT_COLUMNS)
    .eq("owner_user_id", ownerId).eq("id", draftId).maybeSingle();
  if (!draft) return null;
  return toPostView(admin, ownerId, draft as Record<string, unknown>, await loadAssetRow(admin, ownerId, draftId));
}

/**
 * Strict owner-scoped read used by ingestion. The ordinary Post Studio reads
 * intentionally keep their existing nullable behavior; an upload needs to
 * distinguish an absent/non-owned draft from a failed database read.
 */
export async function getPostDraftForIngestion(
  admin: AdminClient,
  ownerId: string,
  draftId: string,
  stage: IngestionStage = "draft_read",
): Promise<PostView | null> {
  const { data: draft, error: draftError } = await admin.from("mara_drafts").select(DRAFT_COLUMNS)
    .eq("owner_user_id", ownerId).eq("id", draftId).maybeSingle();
  if (draftError) throw new IngestionFailure("db_failure", stage);
  if (!draft) return null;

  const { data: asset, error: assetError } = await admin.from(POST_ASSET_TABLE).select(ASSET_COLUMNS)
    .eq("owner_user_id", ownerId).eq("draft_id", draftId).maybeSingle();
  if (assetError) throw new IngestionFailure("db_failure", stage);
  return toPostView(admin, ownerId, draft as Record<string, unknown>, (asset as Record<string, unknown> | null) ?? null);
}

/** Owner-scoped list of every Post Studio draft, newest first. */
export async function listPostDrafts(admin: AdminClient, ownerId: string): Promise<PostView[]> {
  const { data: drafts } = await admin.from("mara_drafts").select(DRAFT_COLUMNS)
    .eq("owner_user_id", ownerId).in("kind", ["instagram_post", "reel", "story"]).order("created_at", { ascending: false }).limit(50);
  const rows = (drafts ?? []) as Record<string, unknown>[];
  return Promise.all(rows.map(async (row) => toPostView(admin, ownerId, row, await loadAssetRow(admin, ownerId, String(row.id)))));
}

export async function toPostView(
  admin: AdminClient, ownerId: string, draft: Record<string, unknown>, asset: Record<string, unknown> | null,
): Promise<PostView> {
  const kind = isPostDraftKind(draft.kind) ? draft.kind : "instagram_post";
  const hasVisual = asset?.status === "uploaded" && typeof asset.storage_path === "string";
  let previewUrl: string | null = null;
  if (hasVisual) {
    const { data: signed } = await admin.storage.from(POST_ASSET_BUCKET)
      .createSignedUrl(String(asset!.storage_path), POST_ASSET_SIGNED_TTL_SECONDS);
    previewUrl = signed?.signedUrl ?? null;
  }
  const scheduledAt = typeof draft.proposed_publish_at === "string" ? draft.proposed_publish_at : null;
  const parts = splitPostCaption(String(draft.content ?? ""));
  const origin = originForAsset(asset?.origin as string | undefined);
  // The draft is the single source of truth for format. Production
  // post_draft_assets has no format column, so nothing is read back from one.
  const format = decodeDraftFormat(draft.channel as string | undefined);
  const state = internalPostState({ status: String(draft.status ?? "draft"), scheduledAt, hasVisual });
  const calendarItemId = await findCalendarItemId(admin, ownerId, String(draft.id));
  return {
    id: String(draft.id),
    conversationId: String(draft.conversation_id ?? ""),
    kind,
    typeLabel: postTypeLabel(kind, (asset?.origin as string | null) ?? null),
    concept: String(draft.title ?? ""),
    caption: parts.caption,
    cta: parts.cta,
    hashtags: parts.hashtags,
    composedCaption: String(draft.content ?? ""),
    format,
    origin,
    originLabel: ORIGIN_LABELS[origin],
    status: (draft.status as PostView["status"]) ?? "draft",
    internalState: state,
    internalStateLabel: POST_STATE_LABELS[state],
    scheduledAt,
    visual: asset
      ? {
          displayName: String(asset.display_name ?? ""),
          mimeType: String(asset.mime_type ?? ""),
          byteSize: Number(asset.byte_size ?? 0),
          format,
          origin,
          previewUrl,
          updatedAt: String(asset.updated_at ?? ""),
        }
      : null,
    visualReady: hasVisual,
    calendarItemId,
    createdAt: String(draft.created_at ?? ""),
    updatedAt: String(draft.updated_at ?? ""),
  };
}

async function findCalendarItemId(admin: AdminClient, ownerId: string, draftId: string): Promise<string | null> {
  const { data } = await admin.from("content_calendar_items").select("id")
    .eq("owner_user_id", ownerId).eq("source_draft_id", draftId).maybeSingle();
  return data?.id ? String(data.id) : null;
}

export interface SavePostInput {
  concept?: string;
  caption?: string;
  cta?: string;
  hashtags?: string[];
  format?: PostFormat;
  scheduledAt?: string | null;
}

/** Persists an edit and re-syncs the calendar row for approved posts. */
export async function savePostDraft(admin: AdminClient, ownerId: string, draftId: string, input: SavePostInput): Promise<PostView | null> {
  const existing = await getPostDraft(admin, ownerId, draftId);
  if (!existing) return null;
  const concept = input.concept !== undefined ? input.concept.trim().slice(0, 160) : existing.concept;
  if (!concept) throw new Error("post_concept_required");
  const caption = input.caption !== undefined ? input.caption : existing.caption;
  const cta = input.cta !== undefined ? input.cta : existing.cta;
  const hashtags = input.hashtags !== undefined ? input.hashtags : existing.hashtags;
  const composed = composePostCaption({ caption, cta, hashtags });
  const scheduledAt = input.scheduledAt !== undefined ? input.scheduledAt : existing.scheduledAt;
  // Stories stay 9:16; a feed post can never pick up the Story-only format.
  const nextFormat = formatForKind(existing.kind, input.format !== undefined ? normalizeFormatInput(input.format) : existing.format);
  const patch: Record<string, unknown> = {
    title: concept,
    content: (composed || concept).slice(0, 12000),
    proposed_publish_at: scheduledAt,
    // Format is persisted on the draft itself, so it is not lost when the post
    // has no visual. See encodeDraftChannel.
    channel: encodeDraftChannel(existing.kind, nextFormat),
  };
  const { data, error } = await admin.from("mara_drafts").update(patch)
    .eq("owner_user_id", ownerId).eq("id", draftId).select("id").maybeSingle();
  if (error || !data) throw new Error("post_update_failed");
  return syncPostToCalendar(admin, ownerId, draftId);
}

function normalizeFormatInput(value: unknown): PostFormat {
  return value === "4:5" || value === "9:16" ? value : "1:1";
}

/** Approves a post. Approval saves state only; nothing is published. */
export async function approvePostDraft(admin: AdminClient, ownerId: string, draftId: string): Promise<PostView | null> {
  const { data, error } = await admin.from("mara_drafts").update({ status: "approved" })
    .eq("owner_user_id", ownerId).eq("id", draftId).select("id").maybeSingle();
  if (error || !data) throw new Error("post_approve_failed");
  return syncPostToCalendar(admin, ownerId, draftId);
}

/**
 * Mirrors an approved post into the existing Content Calendar. Draft posts are
 * removed from the calendar so the calendar only ever shows approved content.
 */
export async function syncPostToCalendar(admin: AdminClient, ownerId: string, draftId: string): Promise<PostView | null> {
  const view = await getPostDraft(admin, ownerId, draftId);
  if (!view) return null;
  const publishAt = view.scheduledAt ?? new Date().toISOString();
  if (view.internalState === "draft") {
    const { data: existing } = await admin.from("content_calendar_items").select("id")
      .eq("owner_user_id", ownerId).eq("source_draft_id", draftId).maybeSingle();
    if (existing?.id) await admin.from("content_calendar_items").delete().eq("owner_user_id", ownerId).eq("id", existing.id);
    // Un-approving must also stop auto-publishing. Published/in-flight items
    // are never cancelled by this.
    await cancelPublishItem(admin, ownerId, draftId).catch(() => false);
    return getPostDraft(admin, ownerId, draftId);
  }
  await admin.from("content_calendar_items").upsert({
    owner_user_id: ownerId,
    source_draft_id: draftId,
    title: view.concept.slice(0, 160),
    channel: calendarChannelFor(view.kind),
    content: view.composedCaption.slice(0, 12000),
    topic: view.typeLabel,
    publish_at: publishAt,
    status: calendarStatusFor(view.internalState),
  }, { onConflict: "owner_user_id,source_draft_id" });
  await syncPostToPublishQueue(admin, ownerId, draftId, view, publishAt);
  return getPostDraft(admin, ownerId, draftId);
}

/**
 * Mirrors an approved+scheduled post into the durable Instagram publish queue,
 * so the cron worker can auto-publish it. Idempotent by (owner, draft), so
 * repeated saves/approvals never create a second publish identity, and a
 * published item is never re-queued.
 *
 * A post with no schedule, no stored visual, or an unpublishable file type is
 * NOT queued — Voom would rather show nothing than promise a publish it cannot
 * perform.
 */
export async function syncPostToPublishQueue(
  admin: AdminClient, ownerId: string, draftId: string, view: PostView, publishAt: string,
): Promise<void> {
  if (!view.scheduledAt || !view.visualReady || !view.visual) {
    await cancelPublishItem(admin, ownerId, draftId).catch(() => false);
    return;
  }
  if (!isPublishableMime(view.visual.mimeType)) return;
  const mediaKind = publishMediaKindForMime(view.visual.mimeType, view.kind);
  if (!mediaKind) return;
  const calendarItemId = await findCalendarItemId(admin, ownerId, draftId);
  await enqueuePublishItem(admin, {
    ownerId,
    draftId,
    calendarItemId,
    mediaKind,
    // Stories are enqueued without caption text: Meta's Story container has no
    // caption parameter, so Voom never promises or sends one.
    caption: mediaKind === "story" ? "" : truncateCaption(view.composedCaption),
    scheduledAt: view.scheduledAt ?? publishAt,
  }).catch(() => null);
}

/**
 * Stores the visual privately and links it to the draft. The row is written
 * only after the upload succeeds, so a post can never show a visual Voom does
 * not own. Returns the previous storage path so the caller can delete it.
 */
export interface PostAssetIngestionDiagnostics extends IngestionLogContext {
  detectedKind: "image" | "video";
  detectedMime: string;
}

function logPostAssetStage(stage: IngestionStage, diagnostics?: PostAssetIngestionDiagnostics, code?: IngestionLogContext["code"]): void {
  if (!diagnostics) return;
  logIngestionStage(stage, {
    ...diagnostics,
    kind: diagnostics.detectedKind,
    mimeType: diagnostics.detectedMime,
    code,
  });
}

export async function putPostAsset(
  admin: AdminClient,
  ownerId: string,
  draftId: string,
  input: { bytes: Uint8Array; mimeType: string; extension: string; displayName: string; origin: PostOrigin },
  diagnostics?: PostAssetIngestionDiagnostics,
): Promise<{ storagePath: string; previousStoragePath: string | null }> {
  // Ownership only. Uploading never depends on a format DB column — production
  // 0021 has none. mara_drafts.channel remains the source of truth for 1:1 / 4:5.
  const { data: draftRow, error: draftError } = await admin.from("mara_drafts").select("id,kind")
    .eq("owner_user_id", ownerId).eq("id", draftId).maybeSingle();
  if (draftError) {
    logPostAssetStage("draft_read", diagnostics, "db_failure");
    throw new IngestionFailure("db_failure", "draft_read");
  }
  if (!draftRow) {
    logPostAssetStage("draft_read", diagnostics, "ownership_failure");
    throw new IngestionFailure("ownership_failure", "draft_read");
  }
  logPostAssetStage("draft_read", diagnostics);

  const digest = createHash("sha256").update(input.bytes).digest("hex").slice(0, 16);
  const storagePath = `${ownerId}/post-assets/${digest}-${draftId}.${input.extension}`;
  // The path is derived from the content digest and the draft, so re-uploading
  // the identical file resolves to the same object. upsert keeps that a no-op
  // instead of a failure; callers compare paths before deleting anything.
  const row = buildPostDraftAssetWrite({
    ownerUserId: ownerId,
    draftId,
    storagePath,
    displayName: input.displayName,
    mimeType: input.mimeType,
    byteSize: input.bytes.length,
    origin: input.origin,
    kind: typeof draftRow.kind === "string" ? draftRow.kind : undefined,
  });

  try {
    const linked = await persistUploadedPostAsset({
      upload: async () => {
        const { error: uploadError } = await admin.storage.from(POST_ASSET_BUCKET)
          .upload(storagePath, input.bytes, { contentType: input.mimeType, upsert: true });
        if (uploadError) throw new Error("upload");
        logPostAssetStage("storage_upload", diagnostics);
      },
      loadPreviousPath: async () => {
        const { data: previous, error: previousError } = await admin.from(POST_ASSET_TABLE).select(ASSET_COLUMNS)
          .eq("owner_user_id", ownerId).eq("draft_id", draftId).maybeSingle();
        if (previousError) throw new Error("previous");
        return typeof previous?.storage_path === "string" ? previous.storage_path : null;
      },
      upsert: async (assetRow) => {
        const { error } = await admin.from(POST_ASSET_TABLE).upsert(assetRow, { onConflict: "owner_user_id,draft_id" });
        if (error) throw new Error("upsert");
        logPostAssetStage("db_upsert", diagnostics);
      },
      removeUploaded: async () => {
        // Never leave an orphan object behind if the link could not be written.
        await admin.storage.from(POST_ASSET_BUCKET).remove([storagePath]);
      },
      row,
    });
    return { storagePath, previousStoragePath: linked.previousStoragePath };
  } catch (reason) {
    if (reason instanceof PostAssetPersistError && reason.code === "storage_failure") {
      logPostAssetStage("storage_upload", diagnostics, "storage_failure");
      // Historical internal label retained for backwards-compatible diagnostics:
      // throw new Error("post_asset_upload_failed");
      throw new IngestionFailure("storage_failure", "storage_upload");
    }
    logPostAssetStage("db_upsert", diagnostics, "db_failure");
    throw new IngestionFailure("db_failure", "db_upsert");
  }
}

/** Confirms the owner-scoped metadata row still points at the just-uploaded object. */
export async function verifyPostAssetStored(
  admin: AdminClient,
  ownerId: string,
  draftId: string,
  storagePath: string,
  diagnostics?: PostAssetIngestionDiagnostics,
): Promise<void> {
  const { data, error } = await admin.from(POST_ASSET_TABLE).select("storage_path,status")
    .eq("owner_user_id", ownerId).eq("draft_id", draftId).maybeSingle();
  if (error || !data || data.status !== "uploaded" || data.storage_path !== storagePath) {
    logPostAssetStage("stored", diagnostics, "db_failure");
    throw new IngestionFailure("db_failure", "stored");
  }
  logPostAssetStage("stored", diagnostics);
}

/**
 * Deletes a private object unless a media generation record still references
 * it, so the paid-generation audit trail never points at a missing file.
 */
export async function removePostAssetObject(admin: AdminClient, ownerId: string, storagePath: string): Promise<void> {
  const { count } = await admin.from("mara_media_generations")
    .select("id", { count: "exact", head: true }).eq("owner_user_id", ownerId).eq("storage_path", storagePath);
  if ((count ?? 0) > 0) return;
  await admin.storage.from(POST_ASSET_BUCKET).remove([storagePath]);
}

export async function deletePostAsset(admin: AdminClient, ownerId: string, draftId: string): Promise<string | null> {
  const existing = await loadAssetRow(admin, ownerId, draftId);
  if (!existing) return null;
  const { error } = await admin.from(POST_ASSET_TABLE).delete().eq("owner_user_id", ownerId).eq("draft_id", draftId);
  if (error) throw new Error("post_asset_delete_failed");
  return typeof existing.storage_path === "string" ? existing.storage_path : null;
}

/** Reads the brand context Post Studio prompts with. */
export async function loadPostBrandContext(admin: AdminClient, ownerId: string) {
  const [{ data: profile }, { data: business }] = await Promise.all([
    admin.from("profiles").select("display_name").eq("user_id", ownerId).maybeSingle(),
    admin.from("businesses")
      .select("brand_name,brand_description,industry,target_customer,main_goal,brand_personality,content_frequency")
      .eq("owner_user_id", ownerId).maybeSingle(),
  ]);
  if (!business) return null;
  return {
    brandName: String(business.brand_name ?? profile?.display_name ?? "Your business"),
    brandDescription: String(business.brand_description ?? ""),
    industry: String(business.industry ?? ""),
    targetCustomer: String(business.target_customer ?? ""),
    mainGoal: String(business.main_goal ?? ""),
    brandPersonality: String(business.brand_personality ?? ""),
    contentFrequency: String(business.content_frequency ?? ""),
  };
}

/** Reads the active marketing plan, if the user has one. */
export async function loadPostPlanContext(admin: AdminClient, ownerId: string) {
  const { data } = await admin.from("marketing_plans")
    .select("business_goal,weekly_strategy,planned_posts,valid_until")
    .eq("owner_user_id", ownerId).eq("status", "active").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!data) return null;
  const posts = Array.isArray(data.planned_posts) ? data.planned_posts : [];
  const topics = posts
    .map((post) => (post && typeof post === "object" && "topic" in post ? String((post as { topic?: unknown }).topic ?? "") : ""))
    .filter(Boolean);
  return {
    businessGoal: String(data.business_goal ?? ""),
    weeklyStrategy: String(data.weekly_strategy ?? ""),
    topics,
    validUntil: typeof data.valid_until === "string" ? data.valid_until : null,
  };
}


/**
 * Batch-resolves how Content Calendar entries should be labelled, using the
 * drafts they came from and where each draft's visual originated. Entries that
 * did not come from Post Studio are simply absent from the returned map, so
 * existing calendar entries keep their current appearance.
 */
export async function resolveCalendarContentTypes(
  admin: AdminClient, ownerId: string, sourceDraftIds: (string | null | undefined)[],
): Promise<Map<string, string>> {
  const ids = [...new Set(sourceDraftIds.filter((id): id is string => typeof id === "string" && id.length > 0))];
  const labels = new Map<string, string>();
  if (!ids.length) return labels;

  const [{ data: drafts }, { data: assets }] = await Promise.all([
    admin.from("mara_drafts").select("id,kind").eq("owner_user_id", ownerId).in("id", ids),
    admin.from(POST_ASSET_TABLE).select("draft_id,origin").eq("owner_user_id", ownerId).in("draft_id", ids),
  ]);

  const originByDraft = new Map<string, string | null>(
    ((assets ?? []) as Record<string, unknown>[]).map((row) => [String(row.draft_id), (row.origin as string | null) ?? null]),
  );
  for (const row of (drafts ?? []) as Record<string, unknown>[]) {
    const draftId = String(row.id);
    if (!isPostDraftKind(row.kind)) continue;
    labels.set(draftId, postTypeLabel(String(row.kind), originByDraft.get(draftId) ?? null));
  }
  return labels;
}

/** Single-entry convenience wrapper around resolveCalendarContentTypes. */
export async function resolveCalendarContentType(
  admin: AdminClient, ownerId: string, sourceDraftId: string | null | undefined,
): Promise<string | null> {
  const labels = await resolveCalendarContentTypes(admin, ownerId, [sourceDraftId]);
  return (typeof sourceDraftId === "string" ? labels.get(sourceDraftId) : null) ?? null;
}

export type { PostDraftKind, PostFormat, PostInternalState, PostOrigin };
