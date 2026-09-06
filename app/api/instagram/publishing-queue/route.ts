import { getCurrentUser } from "@/lib/voom/server-data";
import { readInstagramConfig } from "@/lib/instagram/config";
import { listPublishQueue } from "@/lib/instagram/publish-queue";
import {
  hasPublishPermission,
  INSTAGRAM_PUBLISH_PERMISSION,
  PUBLISH_STATE_LABELS,
  publishStatusTone,
  willAutoPublish,
  PUBLISH_SIGNED_URL_TTL_SECONDS,
} from "@/lib/instagram/publishing";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ASSET_BUCKET = "mara-media";

/**
 * The Instagram publishing queue as the Content Calendar shows it: what Voom
 * plans to auto-publish, when, to which account, and the truthful status.
 * Thumbnails are short-lived signed URLs; storage paths never leave the server.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });

  try {
    const admin = createAdminClient();
    const [rows, { data: connection }] = await Promise.all([
      listPublishQueue(admin, user.id),
      admin.from("instagram_connections").select("username,scopes,status").eq("owner_user_id", user.id).maybeSingle(),
    ]);

    const scopes = (connection?.scopes as string[] | null) ?? [];
    const canPublish = connection?.status === "connected" && hasPublishPermission(scopes);
    const draftIds = rows.map((row) => row.draft_id);
    const assets = draftIds.length
      ? (await admin.from("post_draft_assets").select("draft_id,storage_path,mime_type")
          .eq("owner_user_id", user.id).in("draft_id", draftIds)).data ?? []
      : [];
    const drafts = draftIds.length
      ? (await admin.from("mara_drafts").select("id,title,status").eq("owner_user_id", user.id).in("id", draftIds)).data ?? []
      : [];
    const titleById = new Map(drafts.map((row) => [String(row.id), String(row.title ?? "")]));
    const assetByDraft = new Map(assets.map((row) => [String(row.draft_id), row]));

    const items = [];
    for (const row of rows) {
      const asset = assetByDraft.get(row.draft_id);
      let thumbnailUrl: string | null = null;
      if (asset && typeof asset.storage_path === "string" && String(asset.mime_type).startsWith("image/")) {
        const { data: signed } = await admin.storage.from(ASSET_BUCKET)
          .createSignedUrl(asset.storage_path, PUBLISH_SIGNED_URL_TTL_SECONDS);
        thumbnailUrl = signed?.signedUrl ?? null;
      }
      items.push({
        id: row.id,
        draftId: row.draft_id,
        title: titleById.get(row.draft_id) ?? "Instagram content",
        type: row.media_kind === "reel" ? "Reel" : "Instagram Post",
        account: connection?.username ? `@${connection.username}` : "Instagram not connected",
        scheduledAt: row.scheduled_at,
        status: row.status,
        statusLabel: PUBLISH_STATE_LABELS[row.status] ?? row.status,
        tone: publishStatusTone(row.status),
        autoPublish: willAutoPublish(row.status) && canPublish,
        attempts: row.attempts,
        lastAttemptAt: row.last_attempt_at,
        publishedAt: row.published_at,
        instagramMediaId: row.instagram_media_id,
        failureReason: row.failure_message,
        thumbnailUrl,
      });
    }

    return Response.json({
      items,
      account: connection?.username ? `@${connection.username}` : null,
      connected: connection?.status === "connected",
      configured: Boolean(readInstagramConfig()),
      canPublish,
      missingPermission: connection?.status === "connected" && !canPublish ? INSTAGRAM_PUBLISH_PERMISSION : null,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "The publishing queue couldn't load. Please retry." }, { status: 503 });
  }
}
