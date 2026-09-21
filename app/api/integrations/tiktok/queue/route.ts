import { listTikTokPublishQueue } from "@/lib/tiktok/publish-queue";
import { TIKTOK_PUBLISH_STATE_LABELS, tiktokPublishStatusTone, type TikTokPublishState } from "@/lib/tiktok/publishing";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";

/**
 * The owner's TikTok publish queue — sanitized for presentation.
 *
 * Truthfulness rules:
 *   - statuses are the durable queue's own; nothing is smoothed over. An
 *     item is only `published` when TikTok's OWN post-status endpoint
 *     returned PUBLISH_COMPLETE (the database enforces this).
 *   - the privacy shown is the privacy the creator REQUESTED, alongside the
 *     provider's own status answer — so an unaudited-project private lock
 *     or a later rejection is visible, never hidden.
 *   - no token, upload URL or internal column leaves the server.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  try {
    const rows = await listTikTokPublishQueue(createAdminClient(), user.id, 100);
    return Response.json({
      items: rows.map((row) => ({
        id: row.id,
        draftId: row.draft_id,
        title: row.title,
        status: row.status,
        statusLabel: TIKTOK_PUBLISH_STATE_LABELS[row.status as TikTokPublishState] ?? row.status,
        statusTone: tiktokPublishStatusTone(row.status),
        scheduledAt: row.scheduled_at,
        requestedPrivacy: row.privacy_level,
        providerStatus: row.provider_status,
        providerPostId: row.provider_post_id,
        providerNote: row.provider_note,
        failureCode: row.failure_code,
        failureMessage: row.failure_message,
        publishedAt: row.published_at,
        attempts: row.attempts,
      })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "The TikTok queue is temporarily unavailable." }, { status: 503 });
  }
}
